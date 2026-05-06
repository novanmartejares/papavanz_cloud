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

// --- search + inline preview ------------------------------------------------

test('search: q filters by filename across folders, scoped per-user', async () => {
  const aliceToken = await register('search-alice@example.com');
  const bobToken = await register('search-bob@example.com');

  const folder = await agent()
    .post('/api/folders')
    .set(bearer(aliceToken))
    .send({ name: 'Photos' });

  await agent()
    .post('/api/files')
    .set(bearer(aliceToken))
    .attach('file', Buffer.from('one'), 'beach-2026.jpg');
  await agent()
    .post('/api/files')
    .set(bearer(aliceToken))
    .field('folderId', folder.body.id)
    .attach('file', Buffer.from('two'), 'PHOTO-mountain.jpg');
  await agent()
    .post('/api/files')
    .set(bearer(aliceToken))
    .attach('file', Buffer.from('three'), 'invoice.pdf');

  // Bob has a "beach" file too — must NOT appear in Alice's search.
  await agent()
    .post('/api/files')
    .set(bearer(bobToken))
    .attach('file', Buffer.from('bob'), 'beach-bob.jpg');

  // Alice searches for "beach": one match across folders, only hers.
  const beach = await agent().get('/api/files?q=beach').set(bearer(aliceToken));
  assert.equal(beach.status, 200);
  assert.equal(beach.body.length, 1);
  assert.equal(beach.body[0].originalName, 'beach-2026.jpg');

  // Case-insensitive: "photo" matches "PHOTO-mountain.jpg" via SQLite LIKE.
  const photo = await agent().get('/api/files?q=photo').set(bearer(aliceToken));
  assert.equal(photo.body.length, 1);
  assert.equal(photo.body[0].originalName, 'PHOTO-mountain.jpg');
  // The match is in a folder, not at root.
  assert.equal(photo.body[0].folderId, folder.body.id);

  // No match → empty array, not 404.
  const none = await agent().get('/api/files?q=zzznomatch').set(bearer(aliceToken));
  assert.equal(none.status, 200);
  assert.equal(none.body.length, 0);
});

test('preview: download with inline=1 flips Content-Disposition to inline', async () => {
  const token = await register('preview-1@example.com');
  const up = await agent()
    .post('/api/files')
    .set(bearer(token))
    .attach('file', Buffer.from('img-bytes'), 'photo.jpg');
  const id = up.body.id;

  // Default: attachment.
  const def = await agent().get(`/api/files/${id}/download`).set(bearer(token));
  assert.equal(def.status, 200);
  assert.match(def.headers['content-disposition'], /^attachment;/);

  // inline=1: inline (so the browser <img src=...> renders it).
  const inl = await agent().get(`/api/files/${id}/download?inline=1`).set(bearer(token));
  assert.equal(inl.status, 200);
  assert.match(inl.headers['content-disposition'], /^inline;/);

  // Cross-user inline access still 404 — IDOR holds.
  const otherToken = await register('preview-2@example.com');
  const peek = await agent().get(`/api/files/${id}/download?inline=1`).set(bearer(otherToken));
  assert.equal(peek.status, 404);
});

// --- bulk delete + download -------------------------------------------------

test('bulk delete: removes files + folders + nested files in one call, refunds quota', async () => {
  const token = await register('bulk-delete-1@example.com');

  // Layout: /a.bin (root), /Photos/b.bin, /Photos/2026/c.bin
  const photos = await agent().post('/api/folders').set(bearer(token)).send({ name: 'Photos' });
  const sub = await agent()
    .post('/api/folders')
    .set(bearer(token))
    .send({ name: '2026', parentId: photos.body.id });

  const a = await agent()
    .post('/api/files')
    .set(bearer(token))
    .attach('file', Buffer.alloc(100, 'a'), 'a.bin');
  const b = await agent()
    .post('/api/files')
    .set(bearer(token))
    .field('folderId', photos.body.id)
    .attach('file', Buffer.alloc(150, 'b'), 'b.bin');
  await agent()
    .post('/api/files')
    .set(bearer(token))
    .field('folderId', sub.body.id)
    .attach('file', Buffer.alloc(200, 'c'), 'c.bin');

  const beforeMe = await agent().get('/api/me').set(bearer(token));
  assert.equal(beforeMe.body.storageUsed, 450);

  // Delete /a.bin (direct file) AND /Photos (folder, which contains b.bin and 2026/c.bin)
  const res = await agent()
    .post('/api/bulk/delete')
    .set(bearer(token))
    .send({ fileIds: [a.body.id], folderIds: [photos.body.id] });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.equal(res.body.deletedFiles, 3, 'all 3 files counted');
  assert.equal(res.body.deletedFolders, 2, 'both Photos and 2026 deleted');
  assert.equal(res.body.refundedBytes, 450);

  // b is also gone (was in Photos).
  void b;

  // Storage refunded fully.
  const afterMe = await agent().get('/api/me').set(bearer(token));
  assert.equal(afterMe.body.storageUsed, 0);

  // No folders, no files left.
  const folders = await agent().get('/api/folders').set(bearer(token));
  assert.equal(folders.body.length, 0);
  const files = await agent().get('/api/files?all=1').set(bearer(token));
  assert.equal(files.body.length, 0);
});

test('bulk delete: ignores other users\' ids (no leak, no cross-user delete)', async () => {
  const aliceToken = await register('bulk-delete-alice@example.com');
  const bobToken = await register('bulk-delete-bob@example.com');

  const aliceFile = await agent()
    .post('/api/files')
    .set(bearer(aliceToken))
    .attach('file', Buffer.from('alice'), 'a.txt');
  const aliceFolder = await agent()
    .post('/api/folders')
    .set(bearer(aliceToken))
    .send({ name: 'AliceFolder' });

  // Bob fires a bulk-delete with Alice's IDs. Server must silently ignore them.
  const res = await agent()
    .post('/api/bulk/delete')
    .set(bearer(bobToken))
    .send({ fileIds: [aliceFile.body.id], folderIds: [aliceFolder.body.id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.deletedFiles, 0, 'no Alice files deleted');
  assert.equal(res.body.deletedFolders, 0, 'no Alice folders deleted');
  assert.equal(res.body.refundedBytes, 0);

  // Alice's data is intact.
  const aliceFiles = await agent().get('/api/files?all=1').set(bearer(aliceToken));
  assert.equal(aliceFiles.body.length, 1);
  const aliceFolders = await agent().get('/api/folders').set(bearer(aliceToken));
  assert.equal(aliceFolders.body.length, 1);
});

test('bulk delete: empty body returns 400', async () => {
  const token = await register('bulk-delete-empty@example.com');
  const res = await agent().post('/api/bulk/delete').set(bearer(token)).send({});
  assert.equal(res.status, 400);
});

test('bulk download: returns zip stream of requested files with correct paths', async () => {
  const token = await register('bulk-download-1@example.com');

  const photos = await agent().post('/api/folders').set(bearer(token)).send({ name: 'Photos' });
  await agent()
    .post('/api/files')
    .set(bearer(token))
    .attach('file', Buffer.from('root-payload'), 'root.txt');
  await agent()
    .post('/api/files')
    .set(bearer(token))
    .field('folderId', photos.body.id)
    .attach('file', Buffer.from('photo-payload'), 'photo.txt');

  const list = await agent().get('/api/files?all=1').set(bearer(token));
  const ids = list.body.map((f) => f.id);

  const res = await agent()
    .post('/api/bulk/download')
    .set(bearer(token))
    .send({ fileIds: ids })
    .buffer(true)
    .parse(binaryParser);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/zip/);
  assert.match(res.headers['content-disposition'], /attachment;\s*filename="papavanz-cloud-/);
  // Zip files start with PK\x03\x04
  assert.equal(res.body[0], 0x50, 'first byte must be P');
  assert.equal(res.body[1], 0x4b, 'second byte must be K');
  assert.ok(res.body.length > 0, 'zip must have content');

  // Extract: should contain "root.txt" and "Photos/photo.txt" entries.
  const zipBody = res.body.toString('binary');
  assert.ok(zipBody.includes('root.txt'), 'zip must reference root.txt');
  assert.ok(zipBody.includes('Photos/photo.txt'), 'zip must reference Photos/photo.txt');
});

test('bulk download: cross-user fileIds are silently excluded', async () => {
  const aliceToken = await register('bulk-download-alice@example.com');
  const bobToken = await register('bulk-download-bob@example.com');

  const aliceFile = await agent()
    .post('/api/files')
    .set(bearer(aliceToken))
    .attach('file', Buffer.from('ALICE_SECRET_DATA'), 'alice-secret.txt');

  // Bob also has one file.
  await agent()
    .post('/api/files')
    .set(bearer(bobToken))
    .attach('file', Buffer.from('bob-public'), 'bob.txt');

  // Bob requests both ids — Alice's must be excluded from the zip.
  const bobList = await agent().get('/api/files').set(bearer(bobToken));
  const bobFileId = bobList.body[0].id;

  const res = await agent()
    .post('/api/bulk/download')
    .set(bearer(bobToken))
    .send({ fileIds: [aliceFile.body.id, bobFileId] })
    .buffer(true)
    .parse(binaryParser);
  assert.equal(res.status, 200);
  // Alice's file content must NOT appear in the zip.
  const zipBody = res.body.toString('binary');
  assert.ok(!zipBody.includes('ALICE_SECRET_DATA'), 'zip must NOT contain Alice\'s data');
  assert.ok(!zipBody.includes('alice-secret.txt'), 'zip must NOT reference Alice\'s file');
  assert.ok(zipBody.includes('bob.txt'), 'zip must contain Bob\'s file');
});

test('bulk download: empty selection returns 400', async () => {
  const token = await register('bulk-download-empty@example.com');
  const res = await agent().post('/api/bulk/download').set(bearer(token)).send({});
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------

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
