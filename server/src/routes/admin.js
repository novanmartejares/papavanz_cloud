import { Router } from 'express';
import { z } from 'zod';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { db } from '../db.js';
import { DEFAULT_QUOTA, ADMIN_QUOTA, STORAGE_ROOT } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { logActivity } from '../lib/activity.js';

const router = Router();
router.use(requireAuth);

// Middleware: only admins can access these routes.
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin access required' });
  }
  next();
}

// Augment requireAuth: after verifying JWT, fetch the user's role from DB.
async function loadRole(req, res, next) {
  try {
    const user = await db.user.findUnique({
      where: { id: req.user.id },
      select: { role: true, disabled: true },
    });
    if (!user) return res.status(401).json({ error: 'user not found' });
    if (user.disabled) return res.status(403).json({ error: 'account disabled' });
    req.user.role = user.role;
    next();
  } catch (err) {
    next(err);
  }
}

router.use(loadRole);
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// GET /admin/stats — aggregate system stats + disk info + file type breakdown
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res, next) => {
  try {
    const [userCount, fileCount, totalStorage, activeShares, trashedCount] = await Promise.all([
      db.user.count(),
      db.file.count({ where: { trashedAt: null } }),
      db.user.aggregate({ _sum: { storageUsed: true } }),
      db.shareLink.count(),
      db.file.count({ where: { trashedAt: { not: null } } }),
    ]);

    // Disk usage on the STORAGE_ROOT drive
    let diskFree = 0, diskTotal = 0;
    try {
      const stats = await fsp.statfs(STORAGE_ROOT);
      diskTotal = Number(stats.bsize) * Number(stats.blocks);
      diskFree = Number(stats.bsize) * Number(stats.bavail);
    } catch { /* fallback: leave as 0 */ }

    // File type distribution (top mimeType groups)
    const allFiles = await db.file.findMany({
      where: { trashedAt: null },
      select: { mimeType: true, sizeBytes: true },
    });

    const typeMap = {};
    for (const f of allFiles) {
      const group = f.mimeType ? f.mimeType.split('/')[0] : 'other';
      if (!typeMap[group]) typeMap[group] = { count: 0, bytes: 0 };
      typeMap[group].count++;
      typeMap[group].bytes += Number(f.sizeBytes);
    }
    const fileTypes = Object.entries(typeMap)
      .map(([type, data]) => ({ type, ...data }))
      .sort((a, b) => b.bytes - a.bytes);

    res.json({
      userCount,
      fileCount,
      totalStorageUsed: Number(totalStorage._sum.storageUsed ?? 0),
      activeShares,
      trashedCount,
      diskTotal,
      diskFree,
      fileTypes,
      serverUptime: Math.floor(os.uptime()),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/trends — upload count per day for the last 7 days
// ---------------------------------------------------------------------------
router.get('/trends', async (_req, res, next) => {
  try {
    const days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const start = new Date(now);
      start.setDate(start.getDate() - i);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      const uploads = await db.file.count({
        where: { createdAt: { gte: start, lt: end } },
      });
      const logins = await db.activityLog.count({
        where: { action: 'login', createdAt: { gte: start, lt: end } },
      });
      days.push({
        date: start.toISOString().slice(0, 10),
        uploads,
        logins,
      });
    }
    res.json({ days });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/users — list all users with storage stats.
// ---------------------------------------------------------------------------
router.get('/users', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10)));
    const offset = (page - 1) * limit;
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const where = search ? { email: { contains: search } } : {};

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          role: true,
          storageQuota: true,
          storageUsed: true,
          disabled: true,
          createdAt: true,
          _count: { select: { files: true } },
        },
      }),
      db.user.count({ where }),
    ]);

    res.json({
      users: users.map((u) => ({
        ...u,
        storageQuota: Number(u.storageQuota),
        storageUsed: Number(u.storageUsed),
        fileCount: u._count.files,
        _count: undefined,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/users/:id/files — browse a specific user's files (for admin)
// ---------------------------------------------------------------------------
router.get('/users/:id/files', async (req, res, next) => {
  try {
    const userId = req.params.id;
    const folderId = req.query.folderId === 'null' || !req.query.folderId ? null : req.query.folderId;

    const [files, folders, user] = await Promise.all([
      db.file.findMany({
        where: { userId, folderId, trashedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, originalName: true, sizeBytes: true,
          mimeType: true, createdAt: true, folderId: true, starred: true,
        },
      }),
      db.folder.findMany({
        where: { userId, parentId: folderId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, parentId: true, createdAt: true },
      }),
      db.user.findUnique({
        where: { id: userId },
        select: { email: true },
      }),
    ]);

    if (!user) return res.status(404).json({ error: 'user not found' });

    res.json({
      email: user.email,
      files: files.map((f) => ({ ...f, sizeBytes: Number(f.sizeBytes) })),
      folders,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/users/:id — delete a user account + their files
// ---------------------------------------------------------------------------
router.delete('/users/:id', async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'cannot delete your own account' });
    }

    const user = await db.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, email: true },
    });
    if (!user) return res.status(404).json({ error: 'user not found' });

    // Delete all related records (cascade handles files, folders, shares, logs)
    await db.user.delete({ where: { id: user.id } });

    // Clean up storage directory
    const userDir = `${STORAGE_ROOT}/${user.id}`;
    try { await fsp.rm(userDir, { recursive: true, force: true }); } catch { /* ok */ }

    await logActivity(req.user.id, 'admin', `Deleted user ${user.email}`, req.ip);
    res.json({ ok: true, deleted: user.email });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/files/:id — admin can delete any file
// ---------------------------------------------------------------------------
router.delete('/files/:id', async (req, res, next) => {
  try {
    const file = await db.file.findUnique({
      where: { id: req.params.id },
      select: { id: true, originalName: true, storedName: true, sizeBytes: true, userId: true },
    });
    if (!file) return res.status(404).json({ error: 'file not found' });

    await db.$transaction(async (tx) => {
      await tx.file.delete({ where: { id: file.id } });
      await tx.user.update({
        where: { id: file.userId },
        data: { storageUsed: { decrement: file.sizeBytes } },
      });
    });

    // Remove physical file
    const filePath = `${STORAGE_ROOT}/${file.userId}/${file.storedName}`;
    try { await fsp.unlink(filePath); } catch { /* ok */ }

    await logActivity(req.user.id, 'admin', `Deleted file "${file.originalName}" from user`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /admin/users/:id — update role, disabled, quota.
// ---------------------------------------------------------------------------
const updateUserSchema = z.object({
  role: z.enum(['user', 'admin']).optional(),
  disabled: z.boolean().optional(),
  storageQuota: z.number().int().positive().optional(),
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    const body = updateUserSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }

    // Don't let admin disable themselves.
    if (req.params.id === req.user.id && body.disabled === true) {
      return res.status(400).json({ error: 'cannot disable your own account' });
    }

    const data = {};
    if (body.role !== undefined) {
      data.role = body.role;
      // Auto-adjust quota when role changes (unless a specific quota was also provided).
      if (body.storageQuota === undefined) {
        data.storageQuota = body.role === 'admin' ? ADMIN_QUOTA : DEFAULT_QUOTA;
      }
    }
    if (body.disabled !== undefined) data.disabled = body.disabled;
    if (body.storageQuota !== undefined) data.storageQuota = BigInt(body.storageQuota);

    const updated = await db.user.update({
      where: { id: req.params.id },
      data,
      select: {
        id: true,
        email: true,
        role: true,
        storageQuota: true,
        storageUsed: true,
        disabled: true,
        createdAt: true,
      },
    });

    await logActivity(req.user.id, 'admin', `Updated user ${updated.email}: ${JSON.stringify(body)}`, req.ip);

    res.json({
      ...updated,
      storageQuota: Number(updated.storageQuota),
      storageUsed: Number(updated.storageUsed),
    });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    if (err?.code === 'P2025') return res.status(404).json({ error: 'user not found' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/settings — get server settings
// ---------------------------------------------------------------------------
router.get('/settings', async (_req, res) => {
  res.json({
    inviteCode: process.env.INVITE_CODE || '',
    registrationOpen: process.env.REGISTRATION_CLOSED !== 'true',
    defaultQuotaBytes: Number(DEFAULT_QUOTA),
    adminQuotaBytes: Number(ADMIN_QUOTA),
    storageRoot: STORAGE_ROOT,
    port: process.env.PORT || '8080',
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/settings — update runtime settings
// ---------------------------------------------------------------------------
const settingsSchema = z.object({
  inviteCode: z.string().max(128).optional(),
  registrationOpen: z.boolean().optional(),
});

router.patch('/settings', async (req, res, next) => {
  try {
    const body = settingsSchema.parse(req.body);
    if (body.inviteCode !== undefined) {
      process.env.INVITE_CODE = body.inviteCode;
    }
    if (body.registrationOpen !== undefined) {
      process.env.REGISTRATION_CLOSED = body.registrationOpen ? '' : 'true';
    }
    await logActivity(req.user.id, 'admin', `Updated server settings: ${JSON.stringify(body)}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/shares — list ALL share links across all users
// ---------------------------------------------------------------------------
router.get('/shares', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10)));
    const offset = (page - 1) * limit;

    const [shares, total] = await Promise.all([
      db.shareLink.findMany({
        skip: offset,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { email: true } },
          file: { select: { originalName: true, sizeBytes: true, mimeType: true } },
        },
      }),
      db.shareLink.count(),
    ]);

    res.json({
      shares: shares.map((s) => ({
        id: s.id,
        token: s.token,
        userEmail: s.user.email,
        fileName: s.file.originalName,
        fileSizeBytes: Number(s.file.sizeBytes),
        fileMimeType: s.file.mimeType,
        hasPassword: !!s.password,
        expiresAt: s.expiresAt,
        maxDownloads: s.maxDownloads,
        downloadCount: s.downloadCount,
        createdAt: s.createdAt,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/shares/:id — revoke any share link
// ---------------------------------------------------------------------------
router.delete('/shares/:id', async (req, res, next) => {
  try {
    await db.shareLink.delete({ where: { id: req.params.id } });
    await logActivity(req.user.id, 'admin', `Revoked share link ${req.params.id}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'share not found' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/activity — system-wide activity log.
// ---------------------------------------------------------------------------
router.get('/activity', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10)));
    const offset = (page - 1) * limit;
    const actionFilter = typeof req.query.action === 'string' ? req.query.action.trim() : '';

    const where = actionFilter ? { action: actionFilter } : {};

    const [logs, total] = await Promise.all([
      db.activityLog.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { email: true } } },
      }),
      db.activityLog.count({ where }),
    ]);

    res.json({
      logs: logs.map((l) => ({
        id: l.id,
        userId: l.userId,
        email: l.user.email,
        action: l.action,
        detail: l.detail,
        ipAddress: l.ipAddress,
        createdAt: l.createdAt,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
