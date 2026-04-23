import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';

const BCRYPT_ROUNDS = 10;

export function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password, hash) {
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) return bcrypt.compareSync(password, hash);
  return false;
}

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const session = db.prepare(`
    SELECT s.*, u.id as user_id, u.username, u.email, u.role, u.display_name, u.status as user_status
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);

  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });

  if (session.last_activity) {
    const lastActive = new Date(session.last_activity + 'Z').getTime();
    const idleMinutes = (Date.now() - lastActive) / 60000;
    if (idleMinutes > 60) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return res.status(401).json({ error: 'Session expired due to inactivity. Please log in again.' });
    }
  }
  db.prepare("UPDATE sessions SET last_activity = datetime('now') WHERE token = ?").run(token);

  if (session.user_status === 'suspended') return res.status(403).json({ error: 'Account suspended.' });

  req.user = {
    id: session.user_id,
    username: session.username,
    email: session.email,
    role: session.role,
    displayName: session.display_name,
  };
  next();
}

export function requireSuperadmin(req, res, next) {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });
  next();
}
