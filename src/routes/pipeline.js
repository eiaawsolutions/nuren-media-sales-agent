import { Router } from 'express';
import db from '../db/index.js';
import { enrichedFragment, unenrichedFragment } from '../services/leads.js';

const router = Router();

const STAGES = ['prospect', 'contacted', 'engaged', 'qualified', 'proposal_sent', 'closed_won', 'closed_lost'];

router.get('/', (req, res) => {
  // Default ON: hide pipeline rows whose lead has no reachable contact.
  const requireContact = !(req.query.require_contact === '0' || req.query.require_contact === 0 || req.query.require_contact === 'false');
  const contactClause = requireContact ? `AND ${enrichedFragment('l')}` : '';
  const rows = db.prepare(`
    SELECT p.id, p.stage, p.deal_value_myr, p.probability, p.expected_close_date, p.notes,
           p.created_at, p.updated_at,
           l.id AS lead_id, l.name AS lead_name, l.email AS lead_email, l.title, l.persona, l.lead_type,
           a.id AS account_id, a.name AS account_name, a.industry
    FROM pipeline p
    JOIN leads l ON l.id = p.lead_id
    LEFT JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = ? ${contactClause}
    ORDER BY p.updated_at DESC
  `).all(req.user.id);

  const byStage = Object.fromEntries(STAGES.map(s => [s, []]));
  for (const r of rows) byStage[r.stage] = byStage[r.stage] || [], byStage[r.stage].push(r);

  const totals = STAGES.map(s => ({
    stage: s,
    count: byStage[s]?.length || 0,
    value: (byStage[s] || []).reduce((a, b) => a + (b.deal_value_myr || 0), 0),
  }));
  const hidden_unenriched = requireContact
    ? db.prepare(`
        SELECT COUNT(*) AS c FROM pipeline p JOIN leads l ON l.id = p.lead_id
        WHERE p.user_id = ? AND ${unenrichedFragment('l')}
      `).get(req.user.id).c
    : 0;
  res.json({ stages: STAGES, byStage, totals, hidden_unenriched });
});

router.post('/', (req, res) => {
  const { lead_id, stage = 'prospect', deal_value_myr = 0, probability = 0, expected_close_date, notes, inventory_interest } = req.body || {};
  if (!lead_id) return res.status(400).json({ error: 'lead_id required' });
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'invalid stage' });
  const lead = db.prepare('SELECT id, account_id FROM leads WHERE id = ? AND user_id = ?').get(lead_id, req.user.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const r = db.prepare(
    "INSERT INTO pipeline (user_id, lead_id, account_id, stage, deal_value_myr, probability, expected_close_date, notes, inventory_interest) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(req.user.id, lead_id, lead.account_id, stage, deal_value_myr, probability, expected_close_date || null, notes || null, JSON.stringify(inventory_interest || []));
  db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?,?,?,?)")
    .run(req.user.id, lead_id, 'pipeline_advance', `Added to pipeline at ${stage}`);
  res.json({ id: Number(r.lastInsertRowid) });
});

router.patch('/:id', (req, res) => {
  const allowed = ['stage', 'deal_value_myr', 'probability', 'expected_close_date', 'notes', 'inventory_interest'];
  const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  if (req.body.stage && !STAGES.includes(req.body.stage)) return res.status(400).json({ error: 'invalid stage' });

  const current = db.prepare('SELECT * FROM pipeline WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!current) return res.status(404).json({ error: 'not found' });

  const sets = fields.map(f => `${f} = ?`).join(', ');
  const params = fields.map(f => f === 'inventory_interest' ? JSON.stringify(req.body[f] || []) : req.body[f]);
  params.push(req.params.id, req.user.id);
  db.prepare(`UPDATE pipeline SET ${sets}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(...params);

  if (req.body.stage && req.body.stage !== current.stage) {
    db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?,?,?,?)")
      .run(req.user.id, current.lead_id, 'pipeline_advance', `Moved ${current.stage} -> ${req.body.stage}`);
    if (req.body.stage === 'closed_won' || req.body.stage === 'closed_lost') {
      db.prepare("UPDATE leads SET status = ? WHERE id = ?").run(req.body.stage, current.lead_id);
    }
  }
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM pipeline WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ deleted: r.changes });
});

export default router;
