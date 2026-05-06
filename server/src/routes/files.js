import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureUserDir, safeUserPath, sanitizeFilename } from '../lib/storage.js';
import { MAX_UPLOAD_BYTES } from '../config.js';

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        cb(null, await ensureUserDir(req.user.id));
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, _file, cb) => cb(null, `.tmp-${uuid()}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// GET /api/me — used by the frontend for the storage progress bar
router.get('/me', async (req, res, next) => {
  try {
    const u = await db.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, storageUsed: true, storageQuota: true, createdAt: true },
    });
    if (!u) return res.status(404).json({ error: 'user not found' });
    res.json({
      id: u.id,
      email: u.email,
      createdAt: u.createdAt,
      storageUsed: Number(u.storageUsed),
      storageQuota: Number(u.storageQuota),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/files — list current user's files
router.get('/files', async (req, res, next) => {
  try {
    const files = await db.file.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        originalName: true,
        sizeBytes: true,
        mimeType: true,
        createdAt: true,
      },
    });
    res.json(
      files.map((f) => ({
        ...f,
        sizeBytes: Number(f.sizeBytes),
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/files — upload (multipart, field name "file")
router.post('/files', upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

  const tmpPath = req.file.path;
  const cleanup = async () => {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* ignore */
    }
  };

  try {
    const size = BigInt(req.file.size);
    const storedName = uuid();
    const finalPath = safeUserPath(req.user.id, storedName);
    const originalName = sanitizeFilename(req.file.originalname);

    await db.$transaction(async (tx) => {
      const u = await tx.user.findUnique({
        where: { id: req.user.id },
        select: { storageUsed: true, storageQuota: true },
      });
      if (!u) {
        const e = new Error('user not found');
        e.status = 404;
        throw e;
      }
      if (u.storageUsed + size > u.storageQuota) {
        const e = new Error('storage quota exceeded');
        e.status = 413;
        throw e;
      }
      await tx.file.create({
        data: {
          userId: req.user.id,
          originalName,
          storedName,
          mimeType: req.file.mimetype || null,
          sizeBytes: size,
        },
      });
      await tx.user.update({
        where: { id: req.user.id },
        data: { storageUsed: { increment: size } },
      });
    });

    await fsp.rename(tmpPath, finalPath);
    res.status(201).json({ ok: true, originalName, sizeBytes: Number(size) });
  } catch (err) {
    await cleanup();
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'a file with that name already exists' });
    }
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/files/:id — metadata only
router.get('/files/:id', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: {
        id: true,
        originalName: true,
        sizeBytes: true,
        mimeType: true,
        createdAt: true,
      },
    });
    if (!file) return res.status(404).json({ error: 'not found' });
    res.json({ ...file, sizeBytes: Number(file.sizeBytes) });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id/download — stream the file back
router.get('/files/:id/download', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    const full = safeUserPath(req.user.id, file.storedName);
    res.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    );
    const stream = fs.createReadStream(full);
    stream.on('error', next);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/files/:id
router.delete('/files/:id', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    const full = safeUserPath(req.user.id, file.storedName);

    await db.$transaction([
      db.file.delete({ where: { id: file.id } }),
      db.user.update({
        where: { id: req.user.id },
        data: { storageUsed: { decrement: file.sizeBytes } },
      }),
    ]);
    await fsp.unlink(full).catch(() => {
      /* file may already be gone; metadata is gone, that's what matters */
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
