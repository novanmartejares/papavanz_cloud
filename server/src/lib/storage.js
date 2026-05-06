import fs from 'node:fs/promises';
import path from 'node:path';
import { STORAGE_ROOT } from '../config.js';

export function userDir(userId) {
  return path.resolve(STORAGE_ROOT, `user_${userId}`);
}

export async function ensureUserDir(userId) {
  const dir = userDir(userId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Resolve a path inside the user's directory and verify it cannot escape
 * via `..` or absolute paths. Throws on traversal.
 */
export function safeUserPath(userId, storedName) {
  const root = userDir(userId);
  const full = path.resolve(root, storedName);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('path traversal blocked');
  }
  return full;
}

export function sanitizeFilename(name) {
  return path
    .basename(String(name))
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .slice(0, 255) || 'unnamed';
}
