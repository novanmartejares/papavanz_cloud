import { Router } from 'express';
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { safeUserPath } from '../lib/storage.js';

const router = Router();
router.use(requireAuth);

const MAX_DEPTH = 32;

// Folder names: same restrictions as filenames.
function sanitizeFolderName(name) {
  const cleaned = String(name)
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .trim()
    .slice(0, 255);
  return cleaned || 'untitled';
}

const createSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().nullable().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  parentId: z.string().uuid().nullable().optional(),
});

// Walk up the tree to compute depth + verify ownership of every ancestor.
// Returns { depth } on success, or throws { status, message }.
async function ascendChain(userId, parentId) {
  let depth = 0;
  let cursor = parentId;
  while (cursor) {
    if (depth >= MAX_DEPTH) {
      const e = new Error('folder depth limit reached');
      e.status = 400;
      throw e;
    }
    // findFirst with userId enforces row-level isolation.
    const f = await db.folder.findFirst({
      where: { id: cursor, userId },
      select: { parentId: true },
    });
    if (!f) {
      const e = new Error('parent folder not found');
      e.status = 404;
      throw e;
    }
    cursor = f.parentId;
    depth++;
  }
  return { depth };
}

// Fetch all descendant folder ids of `rootId` (NOT including rootId itself).
// Uses a recursive CTE — a single round-trip; SQLite supports this.
async function descendantFolderIds(userId, rootId) {
  const rows = await db.$queryRaw`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM "Folder" WHERE "parentId" = ${rootId} AND "userId" = ${userId}
      UNION ALL
      SELECT f.id FROM "Folder" f
        INNER JOIN descendants d ON f."parentId" = d.id
        WHERE f."userId" = ${userId}
    )
    SELECT id FROM descendants
  `;
  return rows.map((r) => r.id);
}

// GET /api/folders — flat list of all folders owned by current user.
// Frontend builds the tree from this.
router.get('/folders', async (req, res, next) => {
  try {
    const folders = await db.folder.findMany({
      where: { userId: req.user.id },
      orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
      select: { id: true, parentId: true, name: true, createdAt: true },
    });
    res.json(folders);
  } catch (err) {
    next(err);
  }
});

// GET /api/folders/:id — one folder + its immediate children (subfolders + files).
router.get('/folders/:id', async (req, res, next) => {
  try {
    const folder = await db.folder.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true, parentId: true, name: true, createdAt: true },
    });
    if (!folder) return res.status(404).json({ error: 'not found' });

    const [subfolders, files] = await Promise.all([
      db.folder.findMany({
        where: { userId: req.user.id, parentId: folder.id },
        orderBy: { name: 'asc' },
        select: { id: true, parentId: true, name: true, createdAt: true },
      }),
      db.file.findMany({
        where: { userId: req.user.id, folderId: folder.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          originalName: true,
          sizeBytes: true,
          mimeType: true,
          createdAt: true,
          folderId: true,
        },
      }),
    ]);

    res.json({
      folder,
      subfolders,
      files: files.map((f) => ({ ...f, sizeBytes: Number(f.sizeBytes) })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/folders — create a folder under parentId (or at root if null).
router.post('/folders', async (req, res, next) => {
  try {
    const { name, parentId } = createSchema.parse(req.body);
    const finalParent = parentId ?? null;

    if (finalParent) {
      const { depth } = await ascendChain(req.user.id, finalParent);
      if (depth + 1 > MAX_DEPTH) {
        return res.status(400).json({ error: 'folder depth limit reached' });
      }
    }

    const folder = await db.folder.create({
      data: {
        userId: req.user.id,
        parentId: finalParent,
        name: sanitizeFolderName(name),
      },
      select: { id: true, parentId: true, name: true, createdAt: true },
    });
    res.status(201).json(folder);
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PATCH /api/folders/:id — rename and/or move.
router.patch('/folders/:id', async (req, res, next) => {
  try {
    const { name, parentId } = patchSchema.parse(req.body);
    const folder = await db.folder.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true, parentId: true },
    });
    if (!folder) return res.status(404).json({ error: 'not found' });

    const updates = {};

    if (name !== undefined) updates.name = sanitizeFolderName(name);

    if (parentId !== undefined) {
      const newParent = parentId ?? null;

      // Disallow moving into self.
      if (newParent === folder.id) {
        return res.status(400).json({ error: 'cannot move folder into itself' });
      }

      // Disallow moving into any of its own descendants (would create a cycle).
      if (newParent) {
        const descendants = await descendantFolderIds(req.user.id, folder.id);
        if (descendants.includes(newParent)) {
          return res.status(400).json({ error: 'cannot move folder into its own descendant' });
        }
        // Also verify the new parent exists and depth still legal.
        const { depth } = await ascendChain(req.user.id, newParent);
        if (depth + 1 > MAX_DEPTH) {
          return res.status(400).json({ error: 'folder depth limit reached' });
        }
      }
      updates.parentId = newParent;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }

    const updated = await db.folder.update({
      where: { id: folder.id },
      data: updates,
      select: { id: true, parentId: true, name: true, createdAt: true },
    });
    res.json(updated);
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/folders/:id — recursively delete folder + all descendants + files.
// FK cascade handles the DB side; we still need to refund quota and unlink disk.
router.delete('/folders/:id', async (req, res, next) => {
  try {
    const folder = await db.folder.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!folder) return res.status(404).json({ error: 'not found' });

    const descendants = await descendantFolderIds(req.user.id, folder.id);
    const allFolderIds = [folder.id, ...descendants];

    // Collect every file in the tree to refund quota + unlink from disk.
    const files = await db.file.findMany({
      where: { userId: req.user.id, folderId: { in: allFolderIds } },
      select: { id: true, storedName: true, sizeBytes: true },
    });

    const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0n);

    await db.$transaction([
      db.folder.delete({ where: { id: folder.id } }), // cascades children + files
      db.user.update({
        where: { id: req.user.id },
        data: { storageUsed: { decrement: totalBytes } },
      }),
    ]);

    // Best-effort disk cleanup (DB rows are already gone, that's the source of truth).
    await Promise.all(
      files.map(async (f) => {
        try {
          const full = safeUserPath(req.user.id, f.storedName);
          await fsp.unlink(full).catch(() => undefined);
        } catch {
          /* path traversal blocked or already gone */
        }
      }),
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
