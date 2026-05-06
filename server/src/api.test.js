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

// --- folders ----------------------------------------------------------------

test('folders: create at root, list, fetch with children', async () => {
  const token = await register('folders-1@example.com');

  const create = await agent()
    .post('/api/folders')
    .set(bearer(token))
    .send({ name: 'Photos' });
  assert.equal(create.status, 201);
  assert.equal(create.body.name, 'Photos');
  assert.equal(create.body.parentId, null);

  const folderId = create.body.id;

  const sub = await agent()
    .post('/api/folders')
    .set(bearer(token))
    .send({ name: '2026', parentId: folderId });
  assert.equal(sub.status, 201);
  assert.equal(sub.body.parentId, folderId);

  const list = await agent().get('/api/folders').set(bearer(token));
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 2);

  const detail = await agent().get(`/api/folders/${folderId}`).set(bearer(token));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.folder.id, folderId);
  assert.equal(detail.body.subfolders.length, 1);
  assert.equal(detail.body.subfolders[0].name, '2026');
});

test('folders: upload file into folder, list filters by folderId', async () => {
  const token = await register('folders-2@example.com');
  const f = await agent()
    .post('/api/folders')
    .set(bearer(token))
    .send({ name: 'Docs' });
  const folderId = f.body.id;

  const up = await agent()
    .post('/api/files')
    .set(bearer(token))
    .field('folderId', folderId)
    .attach('file', Buffer.from('inside-folder'), 'doc.txt');
  assert.equal(up.status, 201);
  assert.equal(up.body.folderId, folderId);

  // Root listing should NOT see the file (default = root only).
  const root = await agent().get('/api/files').set(bearer(token));
  assert.equal(root.status, 200);
  assert.equal(root.body.length, 0);

  // Folder-scoped listing sees it.
  const inFolder = await agent()
    .get(`/api/files?folderId=${folderId}`)
    .set(bearer(token));
  assert.equal(inFolder.status, 200);
  assert.equal(inFolder.body.length, 1);
  assert.equal(inFolder.body[0].folderId, folderId);

  // all=1 sees it too.
  const all = await agent().get('/api/files?all=1').set(bearer(token));
  assert.equal(all.body.length, 1);
});

test('folders: upload with another user\'s folderId returns 404 (IDOR)', async () => {
  const aliceToken = await register('idor-folder-a@example.com');
  const bobToken = await register('idor-folder-b@example.com');

  const aliceFolder = await agent()
    .post('/api/folders')
    .set(bearer(aliceToken))
    .send({ name: 'AlicePrivate' });
  const aliceFolderId = aliceFolder.body.id;

  // Bob tries to upload into Alice's folder by guessing the id.
  const bobUpload = await agent()
    .post('/api/files')
    .set(bearer(bobToken))
    .field('folderId', aliceFolderId)
    .attach('file', Buffer.from('payload'), 'sneaky.txt');
  assert.equal(bobUpload.status, 404, `expected 404, got ${bobUpload.status}: ${bobUpload.text}`);

  // Bob also can't fetch / delete Alice's folder.
  const peek = await agent().get(`/api/folders/${aliceFolderId}`).set(bearer(bobToken));
  assert.equal(peek.status, 404);
  const del = await agent().delete(`/api/folders/${aliceFolderId}`).set(bearer(bobToken));
  assert.equal(del.status, 404);

  // Bob can't list Alice's folders.
  const bobFolders = await agent().get('/api/folders').set(bearer(bobToken));
  assert.equal(bobFolders.body.length, 0);
});

test('folders: PATCH rename', async () => {
  const token = await register('folder-rename@example.com');
  const f = await agent()
    .post('/api/folders')
    .set(bearer(token))
    .send({ name: 'OldName' });
  const id = f.body.id;

  const renamed = await agent()
    .patch(`/api/folders/${id}`)
    .set(bearer(token))
    .send({ name: 'NewName' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'NewName');
});

test('folders: PATCH move into descendant is rejected (no cycles)', async () => {
  const token = await register('folder-cycle@example.com');
  const a = await agent().post('/api/folders').set(bearer(token)).send({ name: 'A' });
  const b = await agent()
    .post('/api/folders')
    .set(bearer(token))
    .send({ name: 'B', parentId: a.body.id });

  // Try to move A into B (B is A's child → cycle)
  const cycle = await agent()
    .patch(`/api/folders/${a.body.id}`)
    .set(bearer(token))
    .send({ parentId: b.body.id });
  assert.equal(cycle.status, 400);
  assert.match(cycle.body.error, /descendant/i);

  // Try to move A into itself
  const self = await agent()
    .patch(`/api/folders/${a.body.id}`)
    .set(bearer(token))
    .send({ parentId: a.body.id });
  assert.equal(self.status, 400);
});

test('folders: DELETE cascades children + files and refunds quota', async () => {
  const token = await register('folder-delete@example.com');

  const root = await agent().post('/api/folders').set(bearer(token)).send({ name: 'Root' });
  const sub = await agent()
    .post('/api/folders')
    .set(bearer(token))
    .send({ name: 'Sub', parentId: root.body.id });

  const payload = Buffer.alloc(500, 'x');
  const up = await agent()
    .post('/api/files')
    .set(bearer(token))
    .field('folderId', sub.body.id)
    .attach('file', payload, 'inside.bin');
  assert.equal(up.status, 201);

  const beforeMe = await agent().get('/api/me').set(bearer(token));
  assert.equal(beforeMe.body.storageUsed, 500);

  // Delete the root → both folders + the file should be gone, quota refunded.
  const del = await agent().delete(`/api/folders/${root.body.id}`).set(bearer(token));
  assert.equal(del.status, 204);

  const afterMe = await agent().get('/api/me').set(bearer(token));
  assert.equal(afterMe.body.storageUsed, 0);

  const folders = await agent().get('/api/folders').set(bearer(token));
  assert.equal(folders.body.length, 0);

  const files = await agent().get('/api/files?all=1').set(bearer(token));
  assert.equal(files.body.length, 0);
});

test('folders: PATCH file move between folders', async () => {
  const token = await register('file-move@example.com');
  const a = await agent().post('/api/folders').set(bearer(token)).send({ name: 'A' });
  const b = await agent().post('/api/folders').set(bearer(token)).send({ name: 'B' });

  const up = await agent()
    .post('/api/files')
    .set(bearer(token))
    .field('folderId', a.body.id)
    .attach('file', Buffer.from('move-me'), 'x.txt');
  const fileId = up.body.id;

  // Move A → B
  const moved = await agent()
    .patch(`/api/files/${fileId}`)
    .set(bearer(token))
    .send({ folderId: b.body.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.folderId, b.body.id);

  // A is empty, B has it.
  const inA = await agent().get(`/api/files?folderId=${a.body.id}`).set(bearer(token));
  assert.equal(inA.body.length, 0);
  const inB = await agent().get(`/api/files?folderId=${b.body.id}`).set(bearer(token));
  assert.equal(inB.body.length, 1);

  // Move back to root (folderId: null)
  const toRoot = await agent()
    .patch(`/api/files/${fileId}`)
    .set(bearer(token))
    .send({ folderId: null });
  assert.equal(toRoot.status, 200);
  assert.equal(toRoot.body.folderId, null);
});
