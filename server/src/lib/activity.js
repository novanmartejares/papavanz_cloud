import { db } from '../db.js';

/**
 * Log a user action into the activity log.
 * Fire-and-forget — errors are swallowed to avoid breaking the main flow.
 */
export async function logActivity(userId, action, detail = null, ipAddress = null) {
  try {
    await db.activityLog.create({
      data: { userId, action, detail, ipAddress },
    });
  } catch (err) {
    console.error('Failed to log activity:', err.message);
  }
}
