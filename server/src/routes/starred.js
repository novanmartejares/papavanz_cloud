import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/starred — list all starred files.
router.get('/', async (req, res, next) => {
  try {
    const files = await db.file.findMany({
      where: { userId: req.user.id, starred: true, trashedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        originalName: true,
        sizeBytes: true,
        mimeType: true,
        createdAt: true,
        folderId: true,
        starred: true,
      },
    });
    res.json(files.map((f) => ({ ...f, sizeBytes: Number(f.sizeBytes) })));
  } catch (err) {
    next(err);
  }
});

// POST /api/starred/:id — star a file.
router.post('/:id', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    await db.file.update({ where: { id: file.id }, data: { starred: true } });
    res.json({ ok: true, starred: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/starred/:id — unstar a file.
router.delete('/:id', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    await db.file.update({ where: { id: file.id }, data: { starred: false } });
    res.json({ ok: true, starred: false });
  } catch (err) {
    next(err);
  }
});

export default router;
