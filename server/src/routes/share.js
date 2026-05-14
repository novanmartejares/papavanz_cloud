import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { safeUserPath } from '../lib/storage.js';
import { logActivity } from '../lib/activity.js';


// --- Authenticated endpoints: create / list / delete share links --------

const authRouter = Router();
authRouter.use(requireAuth);

const createSchema = z.object({
  fileId: z.string().uuid(),
  password: z.string().min(1).max(128).optional(),
  expiresIn: z.number().int().min(1).max(365 * 24).optional(), // hours
  maxDownloads: z.number().int().min(1).max(10000).optional(),
});

// POST /api/shares — create a share link.
authRouter.post('/', async (req, res, next) => {
  try {
    const { fileId, password, expiresIn, maxDownloads } = createSchema.parse(req.body);

    // Verify the file belongs to this user and is not trashed.
    const file = await db.file.findFirst({
      where: { id: fileId, userId: req.user.id, trashedAt: null },
      select: { id: true, originalName: true },
    });
    if (!file) return res.status(404).json({ error: 'file not found' });

    const token = randomBytes(24).toString('base64url');
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 60 * 60 * 1000)
      : null;

    const link = await db.shareLink.create({
      data: {
        token,
        userId: req.user.id,
        fileId,
        password: passwordHash,
        expiresAt,
        maxDownloads: maxDownloads ?? null,
      },
      select: {
        id: true,
        token: true,
        expiresAt: true,
        maxDownloads: true,
        downloadCount: true,
        createdAt: true,
      },
    });

    await logActivity(req.user.id, 'share', `Shared "${file.originalName}"`, req.ip);

    res.status(201).json({
      ...link,
      url: `/s/${link.token}`,
    });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    next(err);
  }
});

// GET /api/shares — list all share links for current user.
authRouter.get('/', async (req, res, next) => {
  try {
    const links = await db.shareLink.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        file: { select: { originalName: true, mimeType: true, sizeBytes: true } },
      },
    });
    res.json(
      links.map((l) => ({
        id: l.id,
        token: l.token,
        url: `/s/${l.token}`,
        fileId: l.fileId,
        fileName: l.file.originalName,
        fileMimeType: l.file.mimeType,
        fileSizeBytes: Number(l.file.sizeBytes),
        hasPassword: !!l.password,
        expiresAt: l.expiresAt,
        maxDownloads: l.maxDownloads,
        downloadCount: l.downloadCount,
        createdAt: l.createdAt,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// DELETE /api/shares/:id — revoke a share link.
authRouter.delete('/:id', async (req, res, next) => {
  try {
    const link = await db.shareLink.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!link) return res.status(404).json({ error: 'not found' });

    await db.shareLink.delete({ where: { id: link.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Public endpoint: access a shared file via token --------------------

const publicRouter = Router();

// GET /s/:token — download the shared file (or show info).
publicRouter.get('/:token', async (req, res, next) => {
  try {
    const link = await db.shareLink.findUnique({
      where: { token: req.params.token },
      include: { file: true },
    });
    if (!link) return res.status(404).json({ error: 'link not found or expired' });

    // Check expiry.
    if (link.expiresAt && new Date() > link.expiresAt) {
      return res.status(410).json({ error: 'link expired' });
    }
    // Check max downloads.
    if (link.maxDownloads && link.downloadCount >= link.maxDownloads) {
      return res.status(410).json({ error: 'download limit reached' });
    }
    // Check if file is trashed.
    if (link.file.trashedAt) {
      return res.status(404).json({ error: 'file no longer available' });
    }
    // If password-protected and not downloading, show info.
    if (link.password && req.query.download !== '1') {
      return res.json({
        fileName: link.file.originalName,
        fileSizeBytes: Number(link.file.sizeBytes),
        fileMimeType: link.file.mimeType,
        hasPassword: true,
        requiresPassword: true,
      });
    }
    // If password-protected, verify.
    if (link.password) {
      const pw = req.query.pw ?? req.headers['x-share-password'] ?? '';
      const ok = await bcrypt.compare(String(pw), link.password);
      if (!ok) return res.status(401).json({ error: 'incorrect password' });
    }

    if (req.query.download !== '1') {
      return res.json({
        fileName: link.file.originalName,
        fileSizeBytes: Number(link.file.sizeBytes),
        fileMimeType: link.file.mimeType,
        hasPassword: false,
      });
    }

    // Stream the file.
    const inline = req.query.inline === '1';
    const full = safeUserPath(link.file.userId, link.file.storedName);
    res.setHeader('Content-Type', link.file.mimeType ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(link.file.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(link.file.originalName)}`,
    );

    // Increment download count.
    await db.shareLink.update({
      where: { id: link.id },
      data: { downloadCount: { increment: 1 } },
    });

    const stream = fs.createReadStream(full);
    stream.on('error', next);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

export { authRouter as shareAuthRoutes, publicRouter as sharePublicRoutes };
