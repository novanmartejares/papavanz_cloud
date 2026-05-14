import { Router } from 'express';
import fsp from 'node:fs/promises';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { safeUserPath } from '../lib/storage.js';
import { logActivity } from '../lib/activity.js';

const router = Router();
router.use(requireAuth);

// GET /api/trash — list trashed files.
router.get('/', async (req, res, next) => {
  try {
    const files = await db.file.findMany({
      where: { userId: req.user.id, trashedAt: { not: null } },
      orderBy: { trashedAt: 'desc' },
      select: {
        id: true,
        originalName: true,
        sizeBytes: true,
        mimeType: true,
        trashedAt: true,
        createdAt: true,
        folderId: true,
      },
    });
    res.json(files.map((f) => ({ ...f, sizeBytes: Number(f.sizeBytes) })));
  } catch (err) {
    next(err);
  }
});

// POST /api/trash/:id — move a file to trash (soft delete).
router.post('/:id', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id, trashedAt: null },
      select: { id: true, originalName: true },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    await db.file.update({
      where: { id: file.id },
      data: { trashedAt: new Date() },
    });

    await logActivity(req.user.id, 'trash', `Trashed "${file.originalName}"`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/trash/:id/restore — restore a file from trash.
router.post('/:id/restore', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id, trashedAt: { not: null } },
      select: { id: true, originalName: true },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    await db.file.update({
      where: { id: file.id },
      data: { trashedAt: null },
    });

    await logActivity(req.user.id, 'restore', `Restored "${file.originalName}"`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/trash/:id — permanently delete a trashed file.
router.delete('/:id', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id, trashedAt: { not: null } },
      include: { versions: true },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    const full = safeUserPath(req.user.id, file.storedName);
    const versions = file.versions || [];
    const totalBytes = file.sizeBytes + versions.reduce((acc, v) => acc + v.sizeBytes, 0n);

    await db.$transaction([
      db.file.delete({ where: { id: file.id } }),
      db.user.update({
        where: { id: req.user.id },
        data: { storageUsed: { decrement: totalBytes } },
      }),
    ]);

    await fsp.unlink(full).catch(() => {});
    await Promise.all(
      versions.map(async (v) => {
        await fsp.unlink(safeUserPath(req.user.id, v.storedName)).catch(() => {});
      })
    );

    await logActivity(req.user.id, 'delete', `Permanently deleted "${file.originalName}" and its versions`, req.ip);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/trash/empty — permanently delete ALL trashed files.
router.post('/empty', async (req, res, next) => {
  try {
    const trashedFiles = await db.file.findMany({
      where: { userId: req.user.id, trashedAt: { not: null } },
      select: { id: true, storedName: true, sizeBytes: true, versions: { select: { storedName: true, sizeBytes: true } } },
    });

    if (trashedFiles.length === 0) return res.json({ deleted: 0 });

    const totalBytes = trashedFiles.reduce((acc, f) => {
      const vBytes = f.versions.reduce((vacc, v) => vacc + v.sizeBytes, 0n);
      return acc + f.sizeBytes + vBytes;
    }, 0n);

    await db.$transaction([
      db.file.deleteMany({
        where: { id: { in: trashedFiles.map((f) => f.id) }, userId: req.user.id },
      }),
      db.user.update({
        where: { id: req.user.id },
        data: { storageUsed: { decrement: totalBytes } },
      }),
    ]);

    // Best-effort disk cleanup.
    await Promise.all(
      trashedFiles.map(async (f) => {
        try {
          await fsp.unlink(safeUserPath(req.user.id, f.storedName)).catch(() => {});
          await Promise.all(f.versions.map(async (v) => {
            await fsp.unlink(safeUserPath(req.user.id, v.storedName)).catch(() => {});
          }));
        } catch {}
      }),
    );

    await logActivity(req.user.id, 'delete', `Emptied trash (${trashedFiles.length} files)`, req.ip);
    res.json({ deleted: trashedFiles.length, refundedBytes: Number(totalBytes) });
  } catch (err) {
    next(err);
  }
});

export default router;
