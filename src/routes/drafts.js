import { Router } from 'express';
import db from '../db/index.js';
import { draftOutbound } from '../services/ai-brain.js';

const router = Router();

/**
 * POST /api/drafts
 * Body: { lead_id, campaign_id?, step_number?, variant_key?, channel?, objection_key? }
 * Generates a draft and stores it in messages (status='drafted'). Does NOT send.
 */
router.post('/', async (req, res) => {
  const {
    lead_id, campaign_id, step_number = 1, variant_key = 'A',
    channel = 'email', objection_key,
  } = req.body || {};
  if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

  try {
    const draft = await draftOutbound({
      leadId: lead_id, campaignId: campaign_id || null,
      stepNumber: step_number, variantKey: variant_key,
      channel, objectionKey: objection_key || null,
      userId: req.user.id,
    });

    const ins = db.prepare(`
      INSERT INTO messages (
        lead_id, campaign_id, direction, channel, step_number, variant_key,
        subject, body, status, classification
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      lead_id, campaign_id || null,
      'outbound', channel, step_number, variant_key,
      draft.subject || null, draft.body,
      'drafted',
      draft.needs_review ? 'needs_review' : null
    );

    db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description, meta) VALUES (?,?,?,?,?,?)")
      .run(req.user.id, lead_id, campaign_id || null, 'ai_action',
        `Drafted ${channel} step ${step_number}${objection_key ? ' (obj:' + objection_key + ')' : ''} — confidence ${draft.confidence}`,
        JSON.stringify({ citations: draft.citations, rationale: draft.rationale }));

    res.json({ id: Number(ins.lastInsertRowid), ...draft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/drafts?lead_id=... — list stored drafts for a lead */
router.get('/', (req, res) => {
  // Column names must be table-qualified: `status`, `direction`, `lead_id` all
  // exist on both `messages` and `leads` and SQLite will throw "ambiguous column
  // name" without the `m.` prefix.
  const where = ["m.direction = 'outbound'", "m.status = 'drafted'"];
  const params = [];
  if (req.query.lead_id) { where.push('m.lead_id = ?'); params.push(req.query.lead_id); }
  const rows = db.prepare(`
    SELECT m.*, l.name AS lead_name, l.email AS lead_email
    FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE l.user_id = ? AND ${where.join(' AND ')}
    ORDER BY m.created_at DESC LIMIT 100
  `).all(req.user.id, ...params);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT m.*, l.name AS lead_name, l.email AS lead_email
    FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE m.id = ? AND l.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'draft not found' });
  res.json(row);
});

router.delete('/:id', (req, res) => {
  const r = db.prepare(`
    DELETE FROM messages WHERE id = ? AND status = 'drafted' AND lead_id IN (SELECT id FROM leads WHERE user_id = ?)
  `).run(req.params.id, req.user.id);
  res.json({ deleted: r.changes });
});

export default router;
