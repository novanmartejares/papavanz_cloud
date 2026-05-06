import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { PORT, HOST, CORS_ORIGINS, IS_PROD } from './config.js';
import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import { notFound, errorHandler } from './middleware/errors.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Cloudflare Tunnel / nginx
  app.use(helmet());

  // Tiny CORS shim — only allow configured origins, with credentials.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use(
    '/auth',
    rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }),
    authRoutes,
  );
  app.use(
    '/api',
    rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }),
    fileRoutes,
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`papavanz_cloud API listening on http://${HOST}:${PORT} (${IS_PROD ? 'prod' : 'dev'})`);
  });
}
