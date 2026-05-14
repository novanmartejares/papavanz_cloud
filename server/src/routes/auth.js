import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db } from '../db.js';
import { ensureUserDir } from '../lib/storage.js';
import { JWT_SECRET, DEFAULT_QUOTA, ADMIN_QUOTA, IS_PROD } from '../config.js';
import { logActivity } from '../lib/activity.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const passwordComplexityRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
const passwordSchema = z.string().min(8).max(128).regex(passwordComplexityRegex, {
  message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: passwordSchema,
  inviteCode: z.string().max(128).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5, // Limit each IP to 5 login requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this IP, please try again after 15 minutes' },
});

const cookieOpts = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};

function issueToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

router.post('/register', async (req, res, next) => {
  try {
    const { email, password, inviteCode } = registerSchema.parse(req.body);
    // Registration can be closed via admin settings.
    if (process.env.REGISTRATION_CLOSED === 'true') {
      return res.status(403).json({ error: 'registration is currently closed' });
    }

    // Optional registration gate. When INVITE_CODE is set in the environment,
    // the request body's inviteCode must match (constant-time compare).
    const required = process.env.INVITE_CODE;
    if (required && required.length > 0) {
      const provided = inviteCode ?? '';
      const a = Buffer.from(required);
      const b = Buffer.from(provided);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (!ok) return res.status(403).json({ error: 'invalid invite code' });
    }

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'email already registered' });

    // First user ever registered automatically becomes admin with 200 GB.
    const userCount = await db.user.count();
    const isFirstUser = userCount === 0;
    const role = isFirstUser ? 'admin' : 'user';
    const quota = isFirstUser ? ADMIN_QUOTA : DEFAULT_QUOTA;

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.user.create({
      data: { email, passwordHash, role, storageQuota: quota },
    });
    await ensureUserDir(user.id);

    const token = issueToken(user);
    await logActivity(user.id, 'register', `Registered account${isFirstUser ? ' (auto-admin)' : ''}`, req.ip);
    res
      .cookie('token', token, cookieOpts)
      .status(201)
      .json({ id: user.id, email: user.email, role: user.role, token });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    next(err);
  }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await db.user.findUnique({ where: { email } });
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    if (user.disabled) return res.status(403).json({ error: 'account disabled' });

    const token = issueToken(user);
    await logActivity(user.id, 'login', `Logged in`, req.ip);
    res.cookie('token', token, cookieOpts).json({ id: user.id, email: user.email, role: user.role, token });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    next(err);
  }
});

// POST /auth/change-password — authenticated user changes their own password.
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const user = await db.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'user not found' });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await db.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });

    await logActivity(user.id, 'security', 'Changed password', req.ip);
    res.json({ ok: true, message: 'password changed successfully' });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    next(err);
  }
});

router.post('/logout', (_req, res) => {
  res.clearCookie('token', { ...cookieOpts, maxAge: 0 }).status(204).end();
});

export default router;

