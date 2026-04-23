import db from '../db/index.js';

/**
 * Seed the default Nuren 4-step sequence if none exists for this user.
 * Day 1 intro, Day 3 case study, Day 6 social proof, Day 10 soft close.
 * Each step has A + B variants for A/B testing (body_template is a one-liner
 * goal hint — the AI draft engine writes the real copy grounded in RAG).
 */
export function ensureDefaultSequence(userId) {
  const existing = db.prepare('SELECT id FROM sequences WHERE user_id = ? AND name = ?').get(userId, 'Nuren default — 4 step');
  if (existing) return existing.id;

  const seqId = Number(db.prepare(
    "INSERT INTO sequences (user_id, name, description) VALUES (?, ?, ?)"
  ).run(userId, 'Nuren default — 4 step', 'Day 1 intro -> Day 3 case study -> Day 6 social proof -> Day 10 soft close. A/B variants.').lastInsertRowid);

  const ins = db.prepare(
    "INSERT INTO sequence_steps (sequence_id, step_number, delay_days, channel, goal, subject_template, body_template, variant_key) VALUES (?,?,?,?,?,?,?,?)"
  );

  const steps = [
    [1, 0, 'email', 'intro_value_hook',   '{{specific_observation}} — ', '(AI writes: one specific observation about {{lead.company}}, one Nuren asset that fits {{lead.industry}}, one soft ask for 15-min call)', 'A'],
    [1, 0, 'email', 'intro_value_hook',   'quick Q on {{lead.company}} & {{lead.industry}}', '(AI writes: question-led opener anchored on {{persona.pain_points[0]}}; soft CTA to 15-min call)', 'B'],
    [2, 2, 'email', 'case_study',         'how one {{lead.industry}} brand used Nuren for {{campaign.objective}}', '(AI writes: concrete rate-card or case-study reference from RAG; cites one specific Nuren package; soft ask)', 'A'],
    [2, 2, 'email', 'case_study',         'Nuren rate card for {{lead.industry}} — 2 slides worth reading', '(AI writes: references specific Nuren rate-card package + numbers from the RAG source; link to meet)', 'B'],
    [3, 5, 'email', 'social_proof',       'the MMY mom audience in numbers', '(AI writes: 1 surprising stat from Digital Mum survey; 1 community/KOL anchor; invitation to test a pilot)', 'A'],
    [3, 5, 'email', 'social_proof',       'our Motherhood community moved the needle for a {{lead.sub_industry}} brand', '(AI writes: 1 anecdote + 1 stat + 1 crisp CTA to meet)', 'B'],
    [4, 9, 'email', 'soft_close',         'two 15-min slots this week — worth a look?', '(AI writes: direct ask; proposes two specific time ranges in the next 3 business days; hybrid model — human closes)', 'A'],
    [4, 9, 'email', 'soft_close',         'last note — keeping it short', '(AI writes: breakup-style soft close; one-line ask; "if now is not right" exit valve)', 'B'],
  ];
  for (const s of steps) ins.run(seqId, ...s);
  return seqId;
}

export function listSequences(userId) {
  const seqs = db.prepare('SELECT * FROM sequences WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  for (const s of seqs) {
    s.steps = db.prepare('SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY step_number, variant_key').all(s.id);
  }
  return seqs;
}

/**
 * Enroll leads into a campaign's sequence.
 * - Skips leads that are already enrolled in this campaign (unique constraint)
 * - Skips leads without an email (no way to send)
 * - Skips leads with status in ('unsubscribed','bounced')
 * - Assigns variant A or B round-robin (deterministic by lead.id parity)
 */
export function enrollLeads({ campaignId, sequenceId, leadIds, userId }) {
  const campaign = db.prepare('SELECT id FROM campaigns WHERE id = ? AND user_id = ?').get(campaignId, userId);
  if (!campaign) throw new Error('campaign not found');
  const sequence = db.prepare('SELECT id FROM sequences WHERE id = ? AND user_id = ?').get(sequenceId, userId);
  if (!sequence) throw new Error('sequence not found');

  const ins = db.prepare(
    "INSERT OR IGNORE INTO sequence_enrollments (campaign_id, sequence_id, lead_id, variant_key, current_step, status, started_at) VALUES (?, ?, ?, ?, 0, 'pending', datetime('now'))"
  );
  let enrolled = 0, skipped = 0;
  const reasons = {};
  const tx = db.transaction(() => {
    for (const id of leadIds) {
      const lead = db.prepare('SELECT id, email, status FROM leads WHERE id = ? AND user_id = ?').get(id, userId);
      if (!lead) { skipped++; reasons.not_found = (reasons.not_found || 0) + 1; continue; }
      if (!lead.email) { skipped++; reasons.no_email = (reasons.no_email || 0) + 1; continue; }
      if (lead.status === 'unsubscribed' || lead.status === 'bounced') { skipped++; reasons[lead.status] = (reasons[lead.status] || 0) + 1; continue; }
      const variant = (lead.id % 2 === 0) ? 'A' : 'B';
      const r = ins.run(campaignId, sequenceId, lead.id, variant);
      if (r.changes) enrolled++;
      else { skipped++; reasons.already_enrolled = (reasons.already_enrolled || 0) + 1; }
    }
  });
  tx();
  return { enrolled, skipped, reasons };
}
