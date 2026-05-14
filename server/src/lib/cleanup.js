/**
 * Auto-cleanup scheduler.
 * Runs every hour and permanently deletes trashed files older than 30 days.
 */
import fsp from 'node:fs/promises';
import { db } from '../db.js';
import { safeUserPath } from '../lib/storage.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function cleanupTrash() {
  try {
    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);

    const expired = await db.file.findMany({
      where: { trashedAt: { not: null, lt: cutoff } },
      select: { id: true, userId: true, storedName: true, sizeBytes: true, originalName: true, versions: { select: { storedName: true, sizeBytes: true } } },
    });

    if (expired.length === 0) return;

    console.log(`[trash-cleanup] Permanently deleting ${expired.length} expired file(s)…`);

    for (const file of expired) {
      try {
        const versions = file.versions || [];
        const totalBytes = file.sizeBytes + versions.reduce((acc, v) => acc + v.sizeBytes, 0n);

        await db.$transaction([
          db.file.delete({ where: { id: file.id } }),
          db.user.update({
            where: { id: file.userId },
            data: { storageUsed: { decrement: totalBytes } },
          }),
        ]);

        const diskPath = safeUserPath(file.userId, file.storedName);
        await fsp.unlink(diskPath).catch(() => {});
        
        await Promise.all(
          versions.map(async (v) => {
            await fsp.unlink(safeUserPath(file.userId, v.storedName)).catch(() => {});
          })
        );

        console.log(`[trash-cleanup] Deleted "${file.originalName}" (user ${file.userId})`);
      } catch (err) {
        console.error(`[trash-cleanup] Failed to delete ${file.id}:`, err.message);
      }
    }

    console.log(`[trash-cleanup] Done. Cleaned ${expired.length} file(s).`);
  } catch (err) {
    console.error('[trash-cleanup] Error:', err.message);
  }
}

let timer = null;

export function startTrashCleanup() {
  // Run once on startup (after 10 seconds delay).
  setTimeout(cleanupTrash, 10_000);

  // Then run every hour.
  timer = setInterval(cleanupTrash, 60 * 60 * 1000);
  console.log('[trash-cleanup] Scheduler started — trashed files expire after 30 days.');
}

export function stopTrashCleanup() {
  if (timer) clearInterval(timer);
}
