import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config.js';

export function requireAuth(req, res, next) {
  const fromCookie = req.cookies?.token;
  const fromHeader = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const token = fromCookie ?? fromHeader;
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}
