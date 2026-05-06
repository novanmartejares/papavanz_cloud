import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import archiver from 'archiver';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { safeUserPath } from '../lib/storage.js';

const router = Router();
router.use(requireAuth);

// Shared schema. Both arrays optional but at least one must be non-empty.
const idsSchema = z.object({
  fileIds: z.array(z.string().uuid()).optional().default([]),
  folderIds: z.array(z.string().uuid()).optional().default([]),
});

// Recursive CTE: collect rootIds and every descendant folder id.
async function expandFolderTree(userId, rootIds) {
  if (rootIds.length === 0) return [];
  // Verify ownership of every root id first; drop any that aren't ours.
  const owned = await db.folder.findMany({
    where: { id: { in: rootIds }, userId },
    select: { id: true },
  });
  const ownedRootIds = owned.map((r) => r.id);
  if (ownedRootIds.length === 0) return [];

  // SQLite recursive CTE — single round trip. Caller already validated `userId`.
  const placeholders = ownedRootIds.map((_, i) => `$${i + 2}`).join(',');
  const rows = await db.$queryRawUnsafe(
    `
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM "Folder" WHERE "userId" = $1 AND id IN (${placeholders})
      UNION ALL
      SELECT f.id FROM "Folder" f
        INNER JOIN descendants d ON f."parentId" = d.id
        WHERE f."userId" = $1
    )
    SELECT DISTINCT id FROM descendants
    `,
    userId,
    ...ownedRootIds,
  );
  return rows.map((r) => r.id);
}

// POST /api/bulk/delete — delete multiple files and/or folders in one transaction.
// Body: { fileIds: string[], folderIds: string[] }
// Returns: { deletedFiles: number, deletedFolders: number, refundedBytes: number }
router.post('/bulk/delete', async (req, res, next) => {
  try {
    const { fileIds, folderIds } = idsSchema.parse(req.body);
    if (fileIds.length === 0 && folderIds.length === 0) {
      return res.status(400).json({ error: 'fileIds or folderIds required' });
    }

    // Expand folder tree → all folder ids to delete.
    const allFolderIds = await expandFolderTree(req.user.id, folderIds);

    // Collect every file: both directly-listed fileIds (owned by user) AND files
    // inside any of the folders being deleted.
    const filesInFolders =
      allFolderIds.length > 0
        ? await db.file.findMany({
            where: { userId: req.user.id, folderId: { in: allFolderIds } },
            select: { id: true, storedName: true, sizeBytes: true },
          })
        : [];

    const directFiles =
      fileIds.length > 0
        ? await db.file.findMany({
            where: { id: { in: fileIds }, userId: req.user.id },
            select: { id: true, storedName: true, sizeBytes: true },
          })
        : [];

    // Dedup (a fileId could also live inside a folder being deleted).
    const seen = new Set();
    const allFiles = [];
    for (const f of [...directFiles, ...filesInFolders]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      allFiles.push(f);
    }

    const totalBytes = allFiles.reduce((acc, f) => acc + f.sizeBytes, 0n);

    // Single transaction: delete file rows that aren't covered by folder cascade,
    // delete the requested folders (cascade), refund quota.
    const directFileIds = directFiles.map((f) => f.id);
    await db.$transaction([
      ...(directFileIds.length > 0
        ? [db.file.deleteMany({ where: { id: { in: directFileIds }, userId: req.user.id } })]
        : []),
      ...(allFolderIds.length > 0
        ? [db.folder.deleteMany({ where: { id: { in: allFolderIds }, userId: req.user.id } })]
        : []),
      db.user.update({
        where: { id: req.user.id },
        data: { storageUsed: { decrement: totalBytes } },
      }),
    ]);

    // Best-effort disk cleanup (DB rows are already gone).
    await Promise.all(
      allFiles.map(async (f) => {
        try {
          const full = safeUserPath(req.user.id, f.storedName);
          await fsp.unlink(full).catch(() => undefined);
        } catch {
          /* path traversal blocked or already gone */
        }
      }),
    );

    res.json({
      deletedFiles: allFiles.length,
      deletedFolders: allFolderIds.length,
      refundedBytes: Number(totalBytes),
    });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    next(err);
  }
});

// POST /api/bulk/download — stream a zip archive of the requested files
// (and recursively, files inside requested folders).
// Body: { fileIds: string[], folderIds: string[] }
// Response: application/zip with Content-Disposition: attachment.
router.post('/bulk/download', async (req, res, next) => {
  try {
    const { fileIds, folderIds } = idsSchema.parse(req.body);
    if (fileIds.length === 0 && folderIds.length === 0) {
      return res.status(400).json({ error: 'fileIds or folderIds required' });
    }

    const allFolderIds = await expandFolderTree(req.user.id, folderIds);

    // Pull file rows + the relative path each file should appear at inside the zip.
    // Strategy: every file gets `<folderPath>/<originalName>`. Files at root
    // (folderId null) just get their originalName. Duplicate names in the same
    // zip path get a numeric suffix.
    const directFiles =
      fileIds.length > 0
        ? await db.file.findMany({
            where: { id: { in: fileIds }, userId: req.user.id },
            select: {
              id: true,
              originalName: true,
              storedName: true,
              folderId: true,
            },
          })
        : [];

    const folderFiles =
      allFolderIds.length > 0
        ? await db.file.findMany({
            where: { userId: req.user.id, folderId: { in: allFolderIds } },
            select: {
              id: true,
              originalName: true,
              storedName: true,
              folderId: true,
            },
          })
        : [];

    const seen = new Set();
    const allFiles = [];
    for (const f of [...directFiles, ...folderFiles]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      allFiles.push(f);
    }

    if (allFiles.length === 0) {
      return res.status(404).json({ error: 'no files to download' });
    }

    // Fetch all folder names we need to build paths.
    const folderRows = await db.folder.findMany({
      where: { userId: req.user.id },
      select: { id: true, parentId: true, name: true },
    });
    const folderById = new Map(folderRows.map((f) => [f.id, f]));

    function pathFor(folderId) {
      if (!folderId) return '';
      const parts = [];
      let cursor = folderId;
      while (cursor) {
        const f = folderById.get(cursor);
        if (!f) break;
        parts.unshift(f.name);
        cursor = f.parentId;
      }
      return parts.join('/');
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="papavanz-cloud-${new Date().toISOString().slice(0, 10)}.zip"`,
    );

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') next(err);
    });
    archive.on('error', (err) => next(err));
    archive.pipe(res);

    // Disambiguate duplicate paths inside the zip by appending (1), (2), …
    const pathCounts = new Map();
    function uniquePath(base) {
      const count = pathCounts.get(base) ?? 0;
      pathCounts.set(base, count + 1);
      if (count === 0) return base;
      const dot = base.lastIndexOf('.');
      if (dot > 0) {
        return `${base.slice(0, dot)} (${count})${base.slice(dot)}`;
      }
      return `${base} (${count})`;
    }

    for (const f of allFiles) {
      const dir = pathFor(f.folderId);
      const base = dir ? `${dir}/${f.originalName}` : f.originalName;
      const entryName = uniquePath(base);
      const full = safeUserPath(req.user.id, f.storedName);
      try {
        archive.append(fs.createReadStream(full), { name: entryName });
      } catch {
        // Path traversal blocked or file missing — skip this entry.
      }
    }

    await archive.finalize();
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    if (!res.headersSent) next(err);
  }
});

export default router;
