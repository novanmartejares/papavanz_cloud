import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/activity — user's own activity log.
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '30', 10)));
    const offset = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      db.activityLog.findMany({
        where: { userId: req.user.id },
        skip: offset,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      db.activityLog.count({ where: { userId: req.user.id } }),
    ]);

    res.json({ logs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
});

export default router;
