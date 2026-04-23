import db from '../db/index.js';
import { getAnthropicClient, getModel, logAICost } from '../utils/anthropic.js';

/**
 * Classify an inbound reply into one of:
 *   - positive        -> leaning toward a meeting, pipeline -> engaged
 *   - objection       -> carries an objection_tag (no_budget / has_agency / send_proposal / not_relevant / other)
 *   - not_now         -> polite defer, pause enrollment for 30 days
 *   - unsubscribe     -> mark lead unsubscribed, stop sequences
 *   - noise           -> OOO, auto-reply, or irrelevant — do nothing
 *
 * Uses Haiku (cheap) for classification. Always returns structured JSON.
 */
export async function classifyReply({ bodyText, subject, leadName, userId, campaignId }) {
  const client = getAnthropicClient();
  const model = getModel('enrichment'); // Haiku — cheap classification

  const sys = `You classify inbound B2B sales replies for Nuren Group's inside-sales AI. Return ONE JSON object, no prose.

Categories (exactly one):
- "positive":     interested / wants to learn more / wants a meeting
- "objection":    raises a concern — then set objection_tag to one of: "no_budget", "has_agency", "send_proposal", "not_relevant", "other"
- "not_now":      polite defer (e.g., "reach out next quarter", "not a priority right now")
- "unsubscribe":  wants to stop receiving emails / asks to be removed
- "noise":        OOO auto-reply, delivery notification, forwarded unrelated content

Schema:
{
  "category": "positive" | "objection" | "not_now" | "unsubscribe" | "noise",
  "objection_tag": "no_budget" | "has_agency" | "send_proposal" | "not_relevant" | "other" | null,
  "confidence": "high" | "medium" | "low",
  "summary": "one-sentence description of what the reply said"
}`;

  const user = `Subject: ${subject || '(no subject)'}
From: ${leadName || '(unknown)'}

Body:
"""
${(bodyText || '').slice(0, 4000)}
"""

Classify.`;

  const res = await client.messages.create({
    model, max_tokens: 200, system: sys,
    messages: [{ role: 'user', content: user }],
  });
  const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  logAICost({
    userId, campaignId, taskType: 'classify_reply', model,
    inputTokens: res.usage?.input_tokens || 0, outputTokens: res.usage?.output_tokens || 0,
  });

  const json = extractJson(text) || { category: 'noise', objection_tag: null, confidence: 'low', summary: 'unparseable' };
  return json;
}

/**
 * Record an inbound reply and act on it — idempotent per (external_id, direction='inbound').
 * Called by the Resend inbound webhook OR manual "mark as replied" UI.
 */
export async function handleInboundReply({ leadId, subject, bodyText, externalId, userId }) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(leadId, userId);
  if (!lead) throw new Error('lead not found');

  // Find the most recent outbound message we sent to this lead — that's what the inbound is replying to
  const lastOutbound = db.prepare(
    "SELECT id, campaign_id, step_number, variant_key FROM messages WHERE lead_id = ? AND direction = 'outbound' AND status IN ('sent','delivered','opened','clicked') ORDER BY sent_at DESC LIMIT 1"
  ).get(leadId);

  // Insert inbound record
  const ins = db.prepare(`
    INSERT INTO messages (lead_id, campaign_id, direction, channel, subject, body, status, external_id, replied_at)
    VALUES (?, ?, 'inbound', 'email', ?, ?, 'replied', ?, datetime('now'))
  `).run(leadId, lastOutbound?.campaign_id || null, subject || null, bodyText || '', externalId || null);
  const inboundId = Number(ins.lastInsertRowid);

  // Classify
  const cls = await classifyReply({
    bodyText, subject, leadName: lead.name,
    userId, campaignId: lastOutbound?.campaign_id,
  });
  db.prepare('UPDATE messages SET classification = ?, objection_tag = ? WHERE id = ?')
    .run(cls.category, cls.objection_tag || null, inboundId);

  // Mark the outbound it replied to as "replied" (for analytics)
  if (lastOutbound) {
    db.prepare("UPDATE messages SET replied_at = datetime('now'), status = 'replied' WHERE id = ?").run(lastOutbound.id);
  }

  // Act on classification
  let action = 'no_action';
  if (cls.category === 'unsubscribe') {
    db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(leadId);
    db.prepare("UPDATE sequence_enrollments SET status = 'unsubscribed', paused_reason = 'reply_unsubscribe', last_action_at = datetime('now') WHERE lead_id = ? AND status = 'running'").run(leadId);
    action = 'unsubscribed';
  } else if (cls.category === 'positive') {
    db.prepare("UPDATE leads SET status = CASE WHEN status IN ('new','contacted','engaged') THEN 'engaged' ELSE status END WHERE id = ?").run(leadId);
    db.prepare("UPDATE sequence_enrollments SET status = 'replied', paused_reason = 'reply_positive', last_action_at = datetime('now') WHERE lead_id = ? AND status = 'running'").run(leadId);
    advancePipelineTo(leadId, userId, 'engaged');
    action = 'paused_positive';
  } else if (cls.category === 'objection') {
    db.prepare("UPDATE leads SET status = CASE WHEN status IN ('new','contacted') THEN 'engaged' ELSE status END WHERE id = ?").run(leadId);
    db.prepare("UPDATE sequence_enrollments SET status = 'replied', paused_reason = ? , last_action_at = datetime('now') WHERE lead_id = ? AND status = 'running'")
      .run('reply_objection:' + (cls.objection_tag || 'other'), leadId);
    advancePipelineTo(leadId, userId, 'engaged');
    action = 'paused_objection';
  } else if (cls.category === 'not_now') {
    db.prepare("UPDATE sequence_enrollments SET status = 'paused', paused_reason = 'reply_not_now', last_action_at = datetime('now') WHERE lead_id = ? AND status = 'running'").run(leadId);
    action = 'paused_not_now';
  }
  // 'noise' = no action

  db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description, meta) VALUES (?,?,?,?,?,?)")
    .run(userId, leadId, lastOutbound?.campaign_id || null, 'email_replied',
         `Reply classified as ${cls.category}${cls.objection_tag ? ' (' + cls.objection_tag + ')' : ''}. ${cls.summary}`,
         JSON.stringify({ action, confidence: cls.confidence, reply_message_id: inboundId }));

  return { message_id: inboundId, classification: cls, action };
}

function advancePipelineTo(leadId, userId, targetStage) {
  const ORDER = ['prospect', 'contacted', 'engaged', 'qualified', 'proposal_sent', 'closed_won', 'closed_lost'];
  const targetIdx = ORDER.indexOf(targetStage);
  const row = db.prepare('SELECT id, stage FROM pipeline WHERE lead_id = ? AND user_id = ?').get(leadId, userId);
  if (!row) {
    db.prepare("INSERT INTO pipeline (user_id, lead_id, account_id, stage) VALUES (?, ?, (SELECT account_id FROM leads WHERE id = ?), ?)")
      .run(userId, leadId, leadId, targetStage);
    return;
  }
  if (ORDER.indexOf(row.stage) < targetIdx) {
    db.prepare("UPDATE pipeline SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(targetStage, row.id);
  }
}

function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
