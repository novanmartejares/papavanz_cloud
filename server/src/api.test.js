import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

// --- isolated test environment -----------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'papavanz-cloud-test-'));
const dbPath = path.join(tmpRoot, 'test.db');
const storagePath = path.join(tmpRoot, 'storage');
fs.mkdirSync(storagePath, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret';
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.STORAGE_ROOT = storagePath;
process.env.DEFAULT_QUOTA_BYTES = '1024'; // 1 KB quota — easy to fill in tests
process.env.MAX_UPLOAD_BYTES = '2048';

execSync('npx prisma migrate deploy', {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  stdio: 'inherit',
});

const { default: supertest } = await import('supertest');
const { createApp } = await import('./index.js');
const { db } = await import('./db.js');

const app = createApp();
const agent = () => supertest(app);

// --- helpers -----------------------------------------------------------------
async function register(email, password = 'password123') {
  const res = await agent().post('/auth/register').send({ email, password });
  assert.equal(res.status, 201, `register failed: ${res.text}`);
  return res.body.token;
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function binaryParser(res, cb) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

// --- tests -------------------------------------------------------------------
test.after(async () => {
  await db.$disconnect();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('register creates user folder and returns quota info', async () => {
  const token = await register('alice@example.com');
  const me = await agent().get('/api/me').set(bearer(token));
  assert.equal(me.status, 200);
  assert.equal(me.body.email, 'alice@example.com');
  assert.equal(me.body.storageUsed, 0);
  assert.equal(me.body.storageQuota, 1024);

  const userDir = path.join(storagePath, `user_${me.body.id}`);
  assert.ok(fs.existsSync(userDir), 'user folder should exist on disk');
});

test('duplicate registration returns 409', async () => {
  await register('dup@example.com');
  const res = await agent()
    .post('/auth/register')
    .send({ email: 'dup@example.com', password: 'password123' });
  assert.equal(res.status, 409);
});

test('login rejects wrong password', async () => {
  await register('login@example.com');
  const res = await agent()
    .post('/auth/login')
    .send({ email: 'login@example.com', password: 'wrong-password' });
  assert.equal(res.status, 401);
});

test('upload, list, download, delete round trip', async () => {
  const token = await register('bob@example.com');
  const payload = Buffer.from('hello world');

  const up = await agent()
    .post('/api/files')
    .set(bearer(token))
    .attach('file', payload, 'hello.txt');
  assert.equal(up.status, 201);

  const list = await agent().get('/api/files').set(bearer(token));
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].originalName, 'hello.txt');
  assert.equal(list.body[0].sizeBytes, payload.length);

  const fileId = list.body[0].id;

  const dl = await agent()
    .get(`/api/files/${fileId}/download`)
    .set(bearer(token))
    .buffer(true)
    .parse(binaryParser);
  assert.equal(dl.status, 200);
  assert.equal(dl.body.toString('utf8'), 'hello world');

  const me = await agent().get('/api/me').set(bearer(token));
  assert.equal(me.body.storageUsed, payload.length);

  const del = await agent().delete(`/api/files/${fileId}`).set(bearer(token));
  assert.equal(del.status, 204);

  const me2 = await agent().get('/api/me').set(bearer(token));
  assert.equal(me2.body.storageUsed, 0);
});

test('IDOR: user A cannot access user B files', async () => {
  const aliceToken = await register('idor-a@example.com');
  const bobToken = await register('idor-b@example.com');

  const up = await agent()
    .post('/api/files')
    .set(bearer(aliceToken))
    .attach('file', Buffer.from('alice secret'), 'secret.txt');
  assert.equal(up.status, 201);

  const list = await agent().get('/api/files').set(bearer(aliceToken));
  const aliceFileId = list.body[0].id;

  // Bob attempts to read Alice's file by ID — must 404, never 200/403.
  const peek = await agent().get(`/api/files/${aliceFileId}`).set(bearer(bobToken));
  assert.equal(peek.status, 404);

  const dl = await agent().get(`/api/files/${aliceFileId}/download`).set(bearer(bobToken));
  assert.equal(dl.status, 404);

  const del = await agent().delete(`/api/files/${aliceFileId}`).set(bearer(bobToken));
  assert.equal(del.status, 404);

  // Alice's file should still be intact.
  const aliceList = await agent().get('/api/files').set(bearer(aliceToken));
  assert.equal(aliceList.body.length, 1);
});

test('quota enforcement: 413 when over limit', async () => {
  const token = await register('quota@example.com');

  // 1 KB quota in tests. Upload 700 bytes → ok.
  const small = Buffer.alloc(700, 'a');
  const ok = await agent()
    .post('/api/files')
    .set(bearer(token))
    .attach('file', small, 'small.bin');
  assert.equal(ok.status, 201);

  // Another 700 bytes would push us to 1400 > 1024 → must 413.
  const reject = await agent()
    .post('/api/files')
    .set(bearer(token))
    .attach('file', small, 'small2.bin');
  assert.equal(reject.status, 413);

  // storageUsed must still be 700 (no leak from the rejected upload).
  const me = await agent().get('/api/me').set(bearer(token));
  assert.equal(me.body.storageUsed, 700);
});

test('unauthenticated requests are rejected', async () => {
  const res = await agent().get('/api/files');
  assert.equal(res.status, 401);
});

test('invite code: when set, register requires the matching code', async () => {
  process.env.INVITE_CODE = 'top-secret-team-invite';
  try {
    // No invite code in body → 403
    const noCode = await agent()
      .post('/auth/register')
      .send({ email: 'invite-1@example.com', password: 'password123' });
    assert.equal(noCode.status, 403);
    assert.match(noCode.body.error, /invite/i);

    // Wrong invite code → 403
    const wrong = await agent()
      .post('/auth/register')
      .send({ email: 'invite-2@example.com', password: 'password123', inviteCode: 'nope' });
    assert.equal(wrong.status, 403);

    // Correct invite code → 201
    const ok = await agent().post('/auth/register').send({
      email: 'invite-3@example.com',
      password: 'password123',
      inviteCode: 'top-secret-team-invite',
    });
    assert.equal(ok.status, 201, `expected 201, got ${ok.status}: ${ok.text}`);
  } finally {
    delete process.env.INVITE_CODE;
  }
});

test('invite code: when unset, register stays open', async () => {
  delete process.env.INVITE_CODE;
  const res = await agent()
    .post('/auth/register')
    .send({ email: 'open-reg@example.com', password: 'password123' });
  assert.equal(res.status, 201);
});
