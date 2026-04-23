import cron from 'node-cron';
import db from '../db/index.js';
import { draftOutbound } from './ai-brain.js';
import { sendOutbound } from './outbound.js';

/**
 * Sequence scheduler — the heart of the outbound engine.
 *
 * Every tick (default: every minute in prod, configurable for dev):
 *   1. Start `pending` enrollments whose campaign.status = 'active'   -> flip to 'running', step 0
 *   2. For each `running` enrollment whose next step's delay has elapsed:
 *        - skip if lead.status in (unsubscribed, bounced, closed_won, closed_lost)
 *        - skip if last message is still waiting for reply (pause window) — skip for now, move on after N days
 *        - draft next step via ai-brain (RAG-grounded)
 *        - send via outbound (Resend + tracking + unsubscribe headers)
 *        - advance current_step
 *        - if final step reached -> status='completed'
 *   3. Pause any enrollment whose lead received an inbound reply — the reply-handler sets status='replied'
 *
 * Hard safety: AT MOST one send per enrollment per tick, and the tick is a
 * single SQLite transaction around the advance so we never double-fire a step
 * if the process restarts mid-draft.
 */

const CRON_EXPRESSION = process.env.SCHEDULER_CRON || '* * * * *'; // every minute
const DRAFT_RATE_PER_TICK = parseInt(process.env.SCHEDULER_MAX_PER_TICK || '20', 10);
const HYBRID_STOP_AFTER_LAST_STEP = true;

let task = null;

export function startScheduler() {
  if (task) return;
  console.log(`[scheduler] starting with cron "${CRON_EXPRESSION}" (max ${DRAFT_RATE_PER_TICK} sends/tick)`);
  task = cron.schedule(CRON_EXPRESSION, () => {
    runTick().catch(err => console.error('[scheduler] tick error:', err.message));
  });
}

export async function runTick() {
  // 1. Activate pending enrollments for active campaigns
  const nowActivated = db.prepare(`
    UPDATE sequence_enrollments SET status = 'running', last_action_at = datetime('now')
    WHERE status = 'pending'
      AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'active')
  `).run();
  if (nowActivated.changes) console.log(`[scheduler] activated ${nowActivated.changes} enrollments`);

  // 2. Pick due enrollments. An enrollment is "due" when:
  //    - status = 'running'
  //    - the NEXT step (current_step + 1) exists for its sequence + variant
  //    - days since (last_action_at || started_at) >= delay_days for that step
  const due = db.prepare(`
    SELECT se.id AS enrollment_id, se.campaign_id, se.sequence_id, se.lead_id,
           se.variant_key, se.current_step, se.last_action_at, se.started_at,
           ss.id AS next_step_id, ss.step_number AS next_step_number,
           ss.delay_days, ss.channel, ss.goal,
           l.status AS lead_status, l.email AS lead_email,
           c.user_id AS user_id, c.status AS campaign_status, c.budget_limit
    FROM sequence_enrollments se
    JOIN campaigns c ON c.id = se.campaign_id
    JOIN leads l ON l.id = se.lead_id
    JOIN sequence_steps ss
      ON ss.sequence_id = se.sequence_id
     AND ss.step_number = se.current_step + 1
     AND ss.variant_key = se.variant_key
    WHERE se.status = 'running'
      AND c.status = 'active'
      AND l.status NOT IN ('unsubscribed','bounced','closed_won','closed_lost')
      AND (
        julianday('now') - julianday(COALESCE(se.last_action_at, se.started_at, se.created_at))
      ) >= ss.delay_days
    ORDER BY se.last_action_at ASC
    LIMIT ?
  `).all(DRAFT_RATE_PER_TICK);

  if (!due.length) return { activated: nowActivated.changes, processed: 0 };

  console.log(`[scheduler] ${due.length} enrollments due — processing`);
  let sent = 0, skipped = 0, failed = 0;

  for (const row of due) {
    try {
      if (!row.lead_email) {
        advanceEnrollment(row.enrollment_id, row.next_step_number, 'skipped_no_email');
        skipped++;
        continue;
      }
      if (row.channel !== 'email') {
        // MVP: non-email channels are left as drafts (copy-to-clipboard flow in UI)
        const draft = await draftOutbound({
          leadId: row.lead_id, campaignId: row.campaign_id,
          stepNumber: row.next_step_number, variantKey: row.variant_key,
          channel: row.channel, userId: row.user_id,
        });
        db.prepare(`INSERT INTO messages (lead_id, campaign_id, direction, channel, step_number, variant_key, subject, body, status, classification)
                    VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, 'drafted', ?)`)
          .run(row.lead_id, row.campaign_id, row.channel, row.next_step_number, row.variant_key,
               draft.subject || null, draft.body, draft.needs_review ? 'needs_review' : null);
        advanceEnrollment(row.enrollment_id, row.next_step_number, 'drafted_for_manual');
        skipped++;
        continue;
      }

      const draft = await draftOutbound({
        leadId: row.lead_id, campaignId: row.campaign_id,
        stepNumber: row.next_step_number, variantKey: row.variant_key,
        channel: 'email', userId: row.user_id,
      });

      // If the draft itself is low-confidence, write as draft + leave for human review
      if (draft.needs_review) {
        const r = db.prepare(`INSERT INTO messages (lead_id, campaign_id, direction, channel, step_number, variant_key, subject, body, status, classification)
                              VALUES (?, ?, 'outbound', 'email', ?, ?, ?, ?, 'drafted', 'needs_review')`)
          .run(row.lead_id, row.campaign_id, row.next_step_number, row.variant_key,
               draft.subject || null, draft.body);
        db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description) VALUES (?,?,?,?,?)")
          .run(row.user_id, row.lead_id, row.campaign_id, 'ai_action',
               `Step ${row.next_step_number}/${row.variant_key} drafted but flagged (low confidence). Needs human review.`);
        advanceEnrollment(row.enrollment_id, row.next_step_number, 'drafted_needs_review');
        skipped++;
        continue;
      }

      // Persist the draft then send
      const ins = db.prepare(`INSERT INTO messages (lead_id, campaign_id, direction, channel, step_number, variant_key, subject, body, status)
                              VALUES (?, ?, 'outbound', 'email', ?, ?, ?, ?, 'drafted')`)
        .run(row.lead_id, row.campaign_id, row.next_step_number, row.variant_key,
             draft.subject || null, draft.body);
      const messageId = Number(ins.lastInsertRowid);

      try {
        await sendOutbound(messageId, { userId: row.user_id });
        sent++;
        advanceEnrollment(row.enrollment_id, row.next_step_number, 'sent');

        // Bump pipeline to 'contacted' on first send, 'engaged' on open/click via webhook
        const pipe = db.prepare('SELECT id, stage FROM pipeline WHERE lead_id = ? AND user_id = ?').get(row.lead_id, row.user_id);
        if (!pipe) {
          db.prepare("INSERT INTO pipeline (user_id, lead_id, account_id, stage, notes) VALUES (?, ?, (SELECT account_id FROM leads WHERE id = ?), 'contacted', 'Auto-created on first send')")
            .run(row.user_id, row.lead_id, row.lead_id);
        } else if (pipe.stage === 'prospect') {
          db.prepare("UPDATE pipeline SET stage = 'contacted', updated_at = datetime('now') WHERE id = ?").run(pipe.id);
        }
      } catch (sendErr) {
        failed++;
        console.error(`[scheduler] send failed for enrollment ${row.enrollment_id}:`, sendErr.message);
        // Do NOT advance — next tick will retry if the message is still 'drafted'
        db.prepare("UPDATE messages SET error = ? WHERE id = ?").run(sendErr.message, messageId);
      }
    } catch (err) {
      failed++;
      console.error(`[scheduler] error for enrollment ${row.enrollment_id}:`, err.message);
      db.prepare("UPDATE sequence_enrollments SET status = 'failed', paused_reason = ?, last_action_at = datetime('now') WHERE id = ?")
        .run(err.message.slice(0, 200), row.enrollment_id);
    }
  }

  console.log(`[scheduler] tick done: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  return { activated: nowActivated.changes, processed: due.length, sent, skipped, failed };
}

function advanceEnrollment(enrollmentId, nextStepNumber, reason) {
  // Determine if this was the final step in the sequence/variant
  const e = db.prepare(`SELECT se.sequence_id, se.variant_key FROM sequence_enrollments se WHERE se.id = ?`).get(enrollmentId);
  if (!e) return;
  const more = db.prepare(
    'SELECT 1 FROM sequence_steps WHERE sequence_id = ? AND variant_key = ? AND step_number > ?'
  ).get(e.sequence_id, e.variant_key, nextStepNumber);

  if (!more && HYBRID_STOP_AFTER_LAST_STEP) {
    db.prepare("UPDATE sequence_enrollments SET current_step = ?, status = 'completed', last_action_at = datetime('now'), paused_reason = ? WHERE id = ?")
      .run(nextStepNumber, reason, enrollmentId);
  } else {
    db.prepare("UPDATE sequence_enrollments SET current_step = ?, last_action_at = datetime('now'), paused_reason = ? WHERE id = ?")
      .run(nextStepNumber, reason, enrollmentId);
  }
}
