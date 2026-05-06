import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const NODE_ENV = process.env.NODE_ENV ?? 'development';
export const IS_PROD = NODE_ENV === 'production';

export const PORT = Number(process.env.PORT ?? 8080);
export const HOST = process.env.HOST ?? '0.0.0.0';

export const JWT_SECRET = required('JWT_SECRET');
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}

export const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT ?? './storage');

export const DEFAULT_QUOTA = BigInt(process.env.DEFAULT_QUOTA_BYTES ?? 5n * 1024n ** 3n);

export const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 5 * 1024 ** 3);

// Optional: absolute path to a built frontend (e.g. /opt/papavanz_cloud/web/dist).
// When set and the directory exists, the API serves it as static files with an
// SPA fallback so the whole app runs through one origin / one port.
export const STATIC_DIR = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : null;
