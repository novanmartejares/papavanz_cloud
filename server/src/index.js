import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { PORT, HOST, CORS_ORIGINS, IS_PROD, STATIC_DIR } from './config.js';
import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import folderRoutes from './routes/folders.js';
import bulkRoutes from './routes/bulk.js';
import adminRoutes from './routes/admin.js';
import { shareAuthRoutes, sharePublicRoutes } from './routes/share.js';
import trashRoutes from './routes/trash.js';
import starredRoutes from './routes/starred.js';
import activityRoutes from './routes/activity.js';
import { notFound, errorHandler } from './middleware/errors.js';
import { startTrashCleanup } from './lib/cleanup.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Cloudflare Tunnel / nginx
  app.use(helmet({ hsts: false, contentSecurityPolicy: false }));

  // Tiny CORS shim — only allow configured origins, with credentials.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Share-Password');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Rate limits are intentionally lax in tests so the suite can register
  // many users in a single run without hitting the limiter.
  const isTest = process.env.NODE_ENV === 'test';
  app.use(
    '/auth',
    rateLimit({
      windowMs: 60_000,
      max: isTest ? 10_000 : 30,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    authRoutes,
  );
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      max: isTest ? 10_000 : 240,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    fileRoutes,
    folderRoutes,
    bulkRoutes,
  );

  // New feature routes (under /api).
  app.use('/api/shares', shareAuthRoutes);
  app.use('/api/trash', trashRoutes);
  app.use('/api/starred', starredRoutes);
  app.use('/api/activity', activityRoutes);

  // Admin routes.
  app.use('/admin', adminRoutes);

  // Public share link download (no auth required).
  app.use('/api/public/shares', sharePublicRoutes);

  // Optionally serve a built frontend (web/dist) from the same origin.
  // Enables single-port deployments behind Cloudflare Tunnel / Tailscale Funnel
  // without needing a separate static-file host.
  if (STATIC_DIR && fs.existsSync(STATIC_DIR)) {
    const indexHtml = path.join(STATIC_DIR, 'index.html');
    app.use(express.static(STATIC_DIR, { index: false, maxAge: '1h' }));
    app.get('*', (req, res, next) => {
      // Don't swallow API/auth/health 404s — those should still hit notFound.
      if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/admin') || req.path === '/health') {
        return next();
      }
      if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
      return next();
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`papavanz_cloud API listening on http://${HOST}:${PORT} (${IS_PROD ? 'prod' : 'dev'})`);
    startTrashCleanup();
  });
}
