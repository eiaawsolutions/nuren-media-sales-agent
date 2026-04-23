import { Router } from 'express';
import db from '../db/index.js';

const router = Router();

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM leads l WHERE l.account_id = a.id) AS lead_count,
      (SELECT COUNT(*) FROM leads l WHERE l.account_id = a.id AND l.lead_type = 'hot') AS hot_leads
    FROM accounts a
    WHERE a.user_id = ?
    ORDER BY hot_leads DESC, a.updated_at DESC
  `).all(req.user.id);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Account not found' });
  a.leads = db.prepare('SELECT id, name, title, email, persona, lead_type, status FROM leads WHERE account_id = ? AND user_id = ?').all(req.params.id, req.user.id);
  res.json(a);
});

router.patch('/:id', (req, res) => {
  const allowed = ['name', 'website', 'industry', 'sub_industry', 'geography', 'employee_range', 'estimated_budget_tier', 'notes'];
  const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const sets = fields.map(f => `${f} = ?`).join(', ');
  const params = fields.map(f => req.body[f]);
  params.push(req.params.id, req.user.id);
  db.prepare(`UPDATE accounts SET ${sets}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(...params);
  res.json({ success: true });
});

export default router;
