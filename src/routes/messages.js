import { Router } from 'express';
import db from '../db/index.js';
import { sendOutbound } from '../services/outbound.js';

const router = Router();

/** POST /api/messages/:id/send — send a drafted message via Resend */
router.post('/:id/send', async (req, res) => {
  try {
    const result = await sendOutbound(parseInt(req.params.id, 10), { userId: req.user.id });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/messages?lead_id= — thread view */
router.get('/', (req, res) => {
  const where = [];
  const params = [req.user.id];
  if (req.query.lead_id) { where.push('m.lead_id = ?'); params.push(req.query.lead_id); }
  const sql = `
    SELECT m.id, m.lead_id, m.campaign_id, m.direction, m.channel, m.step_number, m.variant_key,
           m.subject, m.body, m.status, m.external_id, m.scheduled_at, m.sent_at, m.opened_at,
           m.clicked_at, m.replied_at, m.classification, m.objection_tag, m.created_at,
           l.name AS lead_name, l.email AS lead_email
    FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE l.user_id = ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
    ORDER BY m.created_at DESC LIMIT 500
  `;
  res.json(db.prepare(sql).all(...params));
});

export default router;
