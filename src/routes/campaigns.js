import { Router } from 'express';
import db from '../db/index.js';
import { ensureDefaultSequence, listSequences, enrollLeads } from '../services/sequences.js';
import { generateLeadsForCampaign } from '../services/ai-lead-gen.js';
import { generateLeadsViaApollo } from '../services/apollo-lead-gen.js';

const router = Router();

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM sequence_enrollments se WHERE se.campaign_id = c.id) AS enrolled_count,
      (SELECT COUNT(*) FROM sequence_enrollments se WHERE se.campaign_id = c.id AND se.status = 'running') AS running_count,
      (SELECT COUNT(*) FROM sequence_enrollments se WHERE se.campaign_id = c.id AND se.status = 'replied') AS replied_count,
      (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id AND m.status = 'sent') AS sent_count,
      (SELECT COALESCE(SUM(cost_usd),0) FROM ai_cost_log WHERE campaign_id = c.id) AS ai_cost
    FROM campaigns c WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

router.post('/', (req, res) => {
  const { name, objective = 'consideration', target_industry, target_persona, target_budget_tier = 'any', pitch_angle, budget_limit = 0, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = db.prepare(
    "INSERT INTO campaigns (user_id, name, objective, target_industry, target_persona, target_budget_tier, pitch_angle, budget_limit, notes, status) VALUES (?,?,?,?,?,?,?,?,?,'draft')"
  ).run(req.user.id, name, objective, target_industry || null, target_persona || null, target_budget_tier, pitch_angle || null, budget_limit, notes || null);
  res.json({ id: Number(r.lastInsertRowid) });
});

router.get('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  c.enrollments = db.prepare(`
    SELECT se.*, l.name AS lead_name, l.email AS lead_email, l.persona, l.lead_type
    FROM sequence_enrollments se JOIN leads l ON l.id = se.lead_id
    WHERE se.campaign_id = ?
    ORDER BY se.created_at DESC
  `).all(c.id);
  res.json(c);
});

router.patch('/:id', (req, res) => {
  const allowed = ['name', 'objective', 'target_industry', 'target_persona', 'target_budget_tier', 'pitch_angle', 'status', 'budget_limit', 'notes'];
  const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const sets = fields.map(f => `${f} = ?`).join(', ');
  const params = fields.map(f => req.body[f]);
  params.push(req.params.id, req.user.id);
  db.prepare(`UPDATE campaigns SET ${sets}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(...params);
  res.json({ success: true });
});

router.post('/:id/enroll', (req, res) => {
  const { lead_ids, sequence_id } = req.body || {};
  if (!Array.isArray(lead_ids) || !lead_ids.length) return res.status(400).json({ error: 'lead_ids[] required' });
  const seqId = sequence_id || ensureDefaultSequence(req.user.id);
  try {
    const r = enrollLeads({ campaignId: parseInt(req.params.id, 10), sequenceId: seqId, leadIds: lead_ids, userId: req.user.id });
    res.json({ sequence_id: seqId, ...r });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/campaigns/_/sequences — list all sequences the user owns */
router.get('/_/sequences', (req, res) => {
  const seqs = listSequences(req.user.id);
  if (!seqs.length) ensureDefaultSequence(req.user.id);
  res.json(seqs.length ? seqs : listSequences(req.user.id));
});

/**
 * POST /api/campaigns/:id/generate-leads
 * Kicks off a single web_search-backed Claude call that returns up to `count`
 * verified leads matching the campaign's ICP. Leads are persisted (accounts
 * rollup + verification gate) and attached to this campaign via campaign_leads.
 *
 * Body: { count?: 1..15 }  — defaults to 5. Hard-capped server-side at 15.
 * Returns: { generated, rejected, web_search_uses, requested, leads, rejections }
 *
 * This endpoint can take 30–90 seconds (web_search is slow). The SPA must
 * show a loading state; we don't fire-and-forget because the operator wants
 * to see the lead report synchronously.
 */
router.post('/:id/generate-leads', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    if (!campaignId) return res.status(400).json({ error: 'invalid campaign id' });
    const result = await generateLeadsForCampaign({
      userId: req.user.id,
      campaignId,
      count: req.body?.count || 5,
    });
    res.json(result);
  } catch (err) {
    console.error('[campaigns/generate-leads]', err.message);
    const status = err.code === 'anthropic_credits_depleted' ? 402
      : err.code === 'anthropic_auth_failed' ? 401
      : err.code === 'anthropic_rate_limited' ? 429
      : err.code === 'anthropic_overloaded' ? 503
      : 500;
    res.status(status).json({ error: err.message, code: err.code, billingUrl: err.billingUrl });
  }
});

/**
 * POST /api/campaigns/:id/apollo-generate
 * Apollo.io-backed lead generation. Runs alongside /generate-leads — same
 * campaign ICP fields, faster + verified emails, but less nuance. Returns
 * the same shape as /generate-leads so the UI can share handlers.
 *
 * Body: { count?: 1..15 }  — defaults to 5. Server-clamped at 15.
 * Returns: { generated, rejected, source, requested, total_returned, leads, rejections }
 */
router.post('/:id/apollo-generate', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    if (!campaignId) return res.status(400).json({ error: 'invalid campaign id' });
    const result = await generateLeadsViaApollo({
      userId: req.user.id,
      campaignId,
      count: req.body?.count || 5,
    });
    res.json(result);
  } catch (err) {
    console.error('[campaigns/apollo-generate]', err.message);
    const status = err.code === 'apollo_not_configured' ? 503
      : err.code === 'apollo_plan_insufficient' ? 402
      : err.code === 'apollo_credits_depleted' ? 402
      : err.code === 'apollo_auth_failed' ? 401
      : err.code === 'apollo_rate_limited' ? 429
      : err.code === 'apollo_schema_mismatch' ? 502
      : 500;
    res.status(status).json({ error: err.message, code: err.code, billingUrl: err.billingUrl });
  }
});

export default router;
