import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../db.js';
import { ensureUserDir } from '../lib/storage.js';
import { JWT_SECRET, DEFAULT_QUOTA, IS_PROD } from '../config.js';

const router = Router();

const credsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});

const cookieOpts = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};

function issueToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

router.post('/register', async (req, res, next) => {
  try {
    const { email, password } = credsSchema.parse(req.body);
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.user.create({
      data: { email, passwordHash, storageQuota: DEFAULT_QUOTA },
    });
    await ensureUserDir(user.id);

    const token = issueToken(user);
    res
      .cookie('token', token, cookieOpts)
      .status(201)
      .json({ id: user.id, email: user.email, token });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = credsSchema.parse(req.body);
    const user = await db.user.findUnique({ where: { email } });
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    const token = issueToken(user);
    res.cookie('token', token, cookieOpts).json({ id: user.id, email: user.email, token });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ error: 'invalid input', details: err.issues });
    next(err);
  }
});

router.post('/logout', (_req, res) => {
  res.clearCookie('token', { ...cookieOpts, maxAge: 0 }).status(204).end();
});

export default router;
