import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureUserDir, safeUserPath, sanitizeFilename } from '../lib/storage.js';
import { MAX_UPLOAD_BYTES } from '../config.js';
import { logActivity } from '../lib/activity.js';

// Dangerous file extensions that could harm the server or clients.
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.msi', '.scr', '.pif', '.com',
  '.vbs', '.vbe', '.js', '.jse', '.ws', '.wsf', '.wsc', '.wsh',
  '.ps1', '.psm1', '.psd1', '.reg', '.inf', '.hta', '.cpl',
  '.msp', '.mst', '.sct', '.shb', '.sys', '.dll',
]);

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

// Verify a folderId belongs to the current user. Returns the id (or null).
// Throws { status, message } on mismatch.
async function resolveFolderId(userId, raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'null') return null;
  const folder = await db.folder.findFirst({
    where: { id: String(raw), userId },
    select: { id: true },
  });
  if (!folder) {
    const e = new Error('folder not found');
    e.status = 404;
    throw e;
  }
  return folder.id;
}

// GET /api/me — used by the frontend for the storage progress bar
router.get('/me', async (req, res, next) => {
  try {
    const u = await db.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, role: true, storageUsed: true, storageQuota: true, createdAt: true },
    });
    if (!u) return res.status(404).json({ error: 'user not found' });
    const files = await db.file.findMany({
      where: { userId: req.user.id, trashedAt: null },
      select: { mimeType: true, sizeBytes: true },
    });

    const typeMap = {};
    for (const f of files) {
      const group = f.mimeType ? f.mimeType.split('/')[0] : 'other';
      if (!typeMap[group]) typeMap[group] = { count: 0, bytes: 0 };
      typeMap[group].count++;
      typeMap[group].bytes += Number(f.sizeBytes);
    }
    const fileTypes = Object.entries(typeMap)
      .map(([type, data]) => ({ type, ...data }))
      .sort((a, b) => b.bytes - a.bytes);

    res.json({
      id: u.id,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      storageUsed: Number(u.storageUsed),
      storageQuota: Number(u.storageQuota),
      fileTypes,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/files — list current user's files (excludes trashed).
// Query params:
//   folderId=<uuid>   → list files in that folder (must be owned)
//   folderId=null     → root-level files (no folder)
//   (no folderId)     → root-level files (default, backwards-compatible)
//   all=1             → every file regardless of folder (for search)
//   q=<text>          → case-insensitive substring match on originalName.
//                       implies all=1 (search spans every folder owned by user).
//   recent=1          → most recent 20 files across all folders.
router.get('/files', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const recent = req.query.recent === '1';
    const all = req.query.all === '1' || req.query.all === 'true' || q.length > 0 || recent;
    const where = { userId: req.user.id, trashedAt: null };
    if (!all) {
      const folderId = await resolveFolderId(req.user.id, req.query.folderId);
      where.folderId = folderId;
    }
    if (q) {
      // SQLite's `contains` is case-sensitive by default; lower() on both sides
      // keeps it portable. Limit query length to bound DB work.
      where.originalName = { contains: q.slice(0, 255) };
    }
    const files = await db.file.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: recent ? 20 : q ? 200 : undefined,
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
    res.json(
      files.map((f) => ({
        ...f,
        sizeBytes: Number(f.sizeBytes),
      })),
    );
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/files — upload (multipart, field name "file")
// Optional form field: folderId — destination folder (must be owned).
// Query: ?action=replace&existingId=<id> — replace an existing duplicate.
// Query: ?action=rename — auto-rename to avoid duplicate.
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
    const folderId = await resolveFolderId(req.user.id, req.body?.folderId);
    const size = BigInt(req.file.size);
    const storedName = uuid();
    const finalPath = safeUserPath(req.user.id, storedName);
    let originalName = sanitizeFilename(req.file.originalname);

    // Block dangerous file types.
    const ext = path.extname(originalName).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      await cleanup();
      return res.status(400).json({ error: `File type "${ext}" is not allowed for security reasons` });
    }

    const action = req.query.action || req.body?.action || '';
    const existingId = req.query.existingId || req.body?.existingId || '';

    // Check for duplicate filename in the same folder.
    const duplicate = await db.file.findFirst({
      where: { userId: req.user.id, folderId, originalName, trashedAt: null },
      select: { id: true, originalName: true, sizeBytes: true, createdAt: true },
    });

    if (duplicate && !action) {
      // Duplicate found and no action specified — return 409 to let frontend decide.
      await cleanup();
      return res.status(409).json({
        error: 'duplicate',
        message: `"${originalName}" already exists in this folder`,
        existingFile: { ...duplicate, sizeBytes: Number(duplicate.sizeBytes) },
      });
    }

    // Handle replace action — move old file to FileVersion and update the File.
    if (duplicate && action === 'replace') {
      const oldFile = await db.file.findFirst({
        where: { id: existingId || duplicate.id, userId: req.user.id },
      });
      if (oldFile) {
        const created = await db.$transaction(async (tx) => {
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

          // Create FileVersion to hold the old physical file state
          await tx.fileVersion.create({
            data: {
              fileId: oldFile.id,
              storedName: oldFile.storedName,
              sizeBytes: oldFile.sizeBytes,
              mimeType: oldFile.mimeType,
            },
          });

          // Update the main File row with the new uploaded file details
          const file = await tx.file.update({
            where: { id: oldFile.id },
            data: {
              storedName,
              sizeBytes: size,
              mimeType: req.file.mimetype || null,
            },
            select: { id: true, folderId: true },
          });

          // Charge for the NEW file's size (we still keep the old size in quota)
          await tx.user.update({
            where: { id: req.user.id },
            data: { storageUsed: { increment: size } },
          });

          return file;
        });

        await fsp.rename(tmpPath, finalPath);
        await logActivity(req.user.id, 'upload', `Uploaded new version of "${originalName}"`, req.ip);
        return res.status(200).json({
          ok: true,
          id: created.id,
          folderId: created.folderId,
          originalName,
          sizeBytes: Number(size),
        });
      }
    }

    // Handle auto-rename — append (1), (2), etc.
    if (duplicate && action === 'rename') {
      const baseName = path.basename(originalName, ext);
      let counter = 1;
      let newName = `${baseName} (${counter})${ext}`;
      while (await db.file.findFirst({ where: { userId: req.user.id, folderId, originalName: newName, trashedAt: null } })) {
        counter++;
        newName = `${baseName} (${counter})${ext}`;
      }
      originalName = newName;
    }

    const created = await db.$transaction(async (tx) => {
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
      const file = await tx.file.create({
        data: {
          userId: req.user.id,
          folderId,
          originalName,
          storedName,
          mimeType: req.file.mimetype || null,
          sizeBytes: size,
        },
        select: { id: true, folderId: true },
      });
      await tx.user.update({
        where: { id: req.user.id },
        data: { storageUsed: { increment: size } },
      });
      return file;
    });

    await fsp.rename(tmpPath, finalPath);
    await logActivity(req.user.id, 'upload', `Uploaded "${originalName}"`, req.ip);
    res.status(201).json({
      ok: true,
      id: created.id,
      folderId: created.folderId,
      originalName,
      sizeBytes: Number(size),
    });
  } catch (err) {
    await cleanup();
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
        folderId: true,
        starred: true,
      },
    });
    if (!file) return res.status(404).json({ error: 'not found' });
    res.json({ ...file, sizeBytes: Number(file.sizeBytes) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/files/:id — rename or move to another folder.
const filePatchSchema = z.object({
  originalName: z.string().min(1).max(255).optional(),
  folderId: z.string().uuid().nullable().optional(),
});

router.patch('/files/:id', async (req, res, next) => {
  try {
    const body = filePatchSchema.parse(req.body);
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    const updates = {};
    if (body.originalName !== undefined) {
      updates.originalName = sanitizeFilename(body.originalName);
    }
    if (body.folderId !== undefined) {
      updates.folderId = await resolveFolderId(req.user.id, body.folderId);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }

    const updated = await db.file.update({
      where: { id: file.id },
      data: updates,
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
    res.json({ ...updated, sizeBytes: Number(updated.sizeBytes) });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/files/:id/download — stream the file back.
// Query: inline=1 flips Content-Disposition to "inline" so the browser
// renders the file (used by the preview modal for images/PDFs/video/audio).
router.get('/files/:id/download', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    const inline = req.query.inline === '1' || req.query.inline === 'true';
    const full = safeUserPath(req.user.id, file.storedName);
    res.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    );

    if (!inline) {
      logActivity(req.user.id, 'download', `Downloaded "${file.originalName}"`, req.ip);
    }

    const stream = fs.createReadStream(full);
    stream.on('error', next);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/files/:id — soft delete (move to trash) instead of hard delete.
router.delete('/files/:id', async (req, res, next) => {
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
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id/versions — list all previous versions of a file
router.get('/files/:id/versions', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        versions: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    res.json(
      file.versions.map((v) => ({
        id: v.id,
        sizeBytes: Number(v.sizeBytes),
        mimeType: v.mimeType,
        createdAt: v.createdAt,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id/versions/:versionId/download — stream a specific old version
router.get('/files/:id/versions/:versionId/download', async (req, res, next) => {
  try {
    const file = await db.file.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!file) return res.status(404).json({ error: 'not found' });

    const version = await db.fileVersion.findFirst({
      where: { id: req.params.versionId, fileId: file.id },
    });
    if (!version) return res.status(404).json({ error: 'version not found' });

    const full = safeUserPath(req.user.id, version.storedName);
    res.setHeader('Content-Type', version.mimeType ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(version.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`
    );

    logActivity(req.user.id, 'download', `Downloaded previous version of "${file.originalName}"`, req.ip);

    const stream = fs.createReadStream(full);
    stream.on('error', next);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

export default router;
