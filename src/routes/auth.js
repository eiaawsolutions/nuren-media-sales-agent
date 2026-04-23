import { Router } from 'express';
import db from '../db/index.js';
import { hashPassword, verifyPassword, generateToken, requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username + password required' });

  const user = db.prepare('SELECT id, username, email, password_hash, role, display_name, status FROM users WHERE username = ? OR email = ?').get(username, username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended.' });

  const token = generateToken();
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO sessions (token, user_id, ip, user_agent, expires_at) VALUES (?,?,?,?,?)').run(
    token, user.id, req.ip || '', req.headers['user-agent'] || '', expires
  );
  res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role, displayName: user.display_name } });
});

router.post('/logout', requireAuth, (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'current + new password required' });
  if (new_password.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password incorrect.' });
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashPassword(new_password), req.user.id);
  res.json({ success: true });
});

export default router;
