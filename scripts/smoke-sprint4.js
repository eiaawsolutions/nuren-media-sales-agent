#!/usr/bin/env node
/**
 * Sprint 4 end-to-end smoke test.
 *   1. Seed 8 leads across 4 segments; simulate sends / opens / replies / meetings / closed_won
 *   2. Verify analytics.funnel() math
 *   3. Verify funnelBySegment() + abPerformance() + topMessages() + dailySeries()
 *   4. Verify connectors: list, upsertCredentials validation, discover stubs error honestly
 *   5. Verify /api/analytics/dashboard shape
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

async function main() {
  const dataDir = path.join(path.resolve(), 'data');
  for (const f of fs.readdirSync(dataDir)) if (f.startsWith('agent.db')) fs.unlinkSync(path.join(dataDir, f));

  const db = (await import('../src/db/index.js')).default;
  const { persistLead } = await import('../src/services/leads.js');
  const analytics = await import('../src/services/analytics.js');
  const connectors = await import('../src/services/connectors/index.js');

  const uid = Number(db.prepare("INSERT INTO users (username,email,password_hash,role) VALUES ('test','t@e.co','$2b$10$x','superadmin')").run().lastInsertRowid);

  console.log('\n========== 1. Seed realistic pipeline data ==========');

  const seg = { fmcg: 'fmcg', healthcare: 'healthcare', education: 'education', ecommerce: 'ecommerce' };
  const leads = [];
  const mkLead = (name, industry, leadType = 'cold') => {
    const r = persistLead({
      name, email: name.toLowerCase().replace(/ /g, '.') + '@' + industry + '.my',
      company: name.split(' ')[0] + ' Co', linkedin_url: 'https://linkedin.com/in/' + name.toLowerCase().replace(/ /g, '-'),
      verification_sources: ['https://linkedin.com/in/x'], confidence_score: 'high', lead_type: leadType,
      industry, persona: 'brand_manager',
      buying_signal: leadType === 'hot' ? 'Recent product launch' : '',
    }, { userId: uid, source: 'csv_upload' });
    leads.push({ id: r.lead_id, name, industry });
    return r.lead_id;
  };

  // 2 leads per segment = 8 total
  mkLead('Jane Doe', seg.fmcg, 'hot');
  mkLead('Mary Lim', seg.fmcg);
  mkLead('Dr Tan', seg.healthcare);
  mkLead('Nurse Wong', seg.healthcare);
  mkLead('Prof Chua', seg.education);
  mkLead('Ms Siti', seg.education);
  mkLead('Alex DTC', seg.ecommerce, 'hot');
  mkLead('Bob Shop', seg.ecommerce);

  // Campaign + sequence
  const campaignId = Number(db.prepare("INSERT INTO campaigns (user_id, name, objective, target_industry, status) VALUES (?, ?, ?, ?, 'active')")
    .run(uid, 'Q2 FMCG push', 'consideration', 'fmcg').lastInsertRowid);

  // Simulate outbound sends: 6 leads contacted, 4 opened, 2 clicked, 3 replied, 2 positive, 1 meeting, 1 closed_won
  function seedSend(leadId, { step, variant, opened, clicked, replied, bounced, positiveReply }) {
    const sent_at = new Date(Date.now() - (14 - leadId) * 86400000).toISOString(); // spread across last 14 days
    const msgId = Number(db.prepare(`
      INSERT INTO messages (lead_id, campaign_id, direction, channel, step_number, variant_key, subject, body, status, sent_at,
                            ${opened ? 'opened_at,' : ''} ${clicked ? 'clicked_at,' : ''} ${replied ? 'replied_at,' : ''} external_id)
      VALUES (?, ?, 'outbound', 'email', ?, ?, ?, ?, ?, ?,
              ${opened ? "datetime(?, '+1 hour')," : ''} ${clicked ? "datetime(?, '+2 hour')," : ''} ${replied ? "datetime(?, '+3 hour')," : ''} 'trk_' || ?)
    `).run(
      leadId, campaignId, step, variant, `Step ${step} subject`, `Step ${step} body for ${leads.find(l => l.id === leadId)?.name}`,
      bounced ? 'bounced' : (replied ? 'replied' : (clicked ? 'clicked' : (opened ? 'opened' : 'sent'))),
      sent_at,
      ...(opened ? [sent_at] : []),
      ...(clicked ? [sent_at] : []),
      ...(replied ? [sent_at] : []),
      'ext' + leadId + step + variant,
    ).lastInsertRowid);
    if (replied) {
      // Insert inbound reply
      db.prepare(`INSERT INTO messages (lead_id, campaign_id, direction, channel, subject, body, status, replied_at, classification)
                  VALUES (?, ?, 'inbound', 'email', ?, ?, 'replied', datetime(?, '+3 hour'), ?)`)
        .run(leadId, campaignId, 'Re: Step ' + step, 'Reply body', sent_at, positiveReply ? 'positive' : 'objection');
    }
    return msgId;
  }

  // Give first 6 leads step-1 sends with varying engagement
  seedSend(leads[0].id, { step: 1, variant: 'A', opened: true, clicked: true, replied: true, positiveReply: true });     // Jane — hot fmcg, positive reply
  seedSend(leads[1].id, { step: 1, variant: 'B', opened: true, replied: true, positiveReply: false });                    // Mary — objection
  seedSend(leads[2].id, { step: 1, variant: 'A', opened: true });                                                         // Tan — healthcare opened
  seedSend(leads[3].id, { step: 1, variant: 'B', opened: false });                                                        // Wong — healthcare no open
  seedSend(leads[4].id, { step: 1, variant: 'A', opened: true, clicked: true, replied: true, positiveReply: true });     // Chua — education, positive
  seedSend(leads[5].id, { step: 1, variant: 'B', bounced: true });                                                        // Siti — bounced

  // Step 2 for Jane + Chua (who opened step 1)
  seedSend(leads[0].id, { step: 2, variant: 'A', opened: true });
  seedSend(leads[4].id, { step: 2, variant: 'A', opened: true });

  // Meeting booked for Jane + Chua
  db.prepare("INSERT INTO appointments (user_id, lead_id, title, scheduled_at, status, type, meet_link, call_token) VALUES (?,?,?,?,?,?,?,?)")
    .run(uid, leads[0].id, 'Jane x Nuren discovery', new Date(Date.now() + 86400000).toISOString(), 'completed', 'discovery', 'https://meet.google.com/abc-defg-hij', 'tok_jane');
  db.prepare("INSERT INTO appointments (user_id, lead_id, title, scheduled_at, status, type, meet_link, call_token) VALUES (?,?,?,?,?,?,?,?)")
    .run(uid, leads[4].id, 'Chua x Nuren discovery', new Date(Date.now() + 86400000 * 3).toISOString(), 'scheduled', 'discovery', 'https://meet.google.com/def-ghij-klm', 'tok_chua');

  // Jane's deal goes to closed_won
  db.prepare("INSERT INTO pipeline (user_id, lead_id, stage, deal_value_myr) VALUES (?, ?, 'closed_won', ?)").run(uid, leads[0].id, 45000);
  // Chua moved to engaged
  db.prepare("INSERT INTO pipeline (user_id, lead_id, stage, deal_value_myr) VALUES (?, ?, 'engaged', ?)").run(uid, leads[4].id, 20000);

  // AI cost log
  db.prepare("INSERT INTO ai_cost_log (user_id, campaign_id, task_type, model, input_tokens, output_tokens, total_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?)").run(uid, campaignId, 'draft_email_step1', 'claude-sonnet-4-6', 2000, 500, 2500, 0.0135);
  db.prepare("INSERT INTO ai_cost_log (user_id, campaign_id, task_type, model, input_tokens, output_tokens, total_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?)").run(uid, campaignId, 'classify_reply', 'claude-haiku-4-5-20251001', 500, 100, 600, 0.0008);
  db.prepare("INSERT INTO ai_cost_log (user_id, campaign_id, task_type, model, input_tokens, output_tokens, total_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?)").run(uid, null, 'vision_rate_card', 'claude-sonnet-4-6', 3000, 800, 3800, 0.021);

  console.log('✓ 8 leads, 8 outbound + 3 inbound messages, 2 appointments, 1 closed_won (RM 45k), 3 AI cost entries');

  console.log('\n========== 2. funnel() math ==========');
  const f = analytics.funnel({ userId: uid });
  console.log(JSON.stringify({ leads_total: f.leads_total, contacted: f.contacted, opened: f.opened, replied: f.replied, positive: f.positive_replies, meetings: f.meetings_booked, won: f.closed_won, revenue: f.revenue_myr, rates: f.rates }, null, 2));
  if (f.leads_total !== 8) throw new Error('leads_total wrong');
  if (f.contacted !== 6) throw new Error('expected contacted=6 (6 unique leads received step-1 sends), got ' + f.contacted);
  if (f.opened !== 4) throw new Error('expected opened=4 (jane, mary, tan, chua), got ' + f.opened);
  if (f.replied !== 3) throw new Error('expected replied=3 inbound count is 3 (jane, mary, chua reply)');  // unique lead count; let us re-check
  if (f.positive_replies !== 2) throw new Error('expected positive=2 (Jane + Chua), got ' + f.positive_replies);
  if (f.meetings_booked !== 2) throw new Error('expected meetings=2');
  if (f.closed_won !== 1) throw new Error('expected closed_won=1');
  if (f.revenue_myr !== 45000) throw new Error('expected revenue=45000');

  console.log('\n========== 3. by-segment + A/B + top + daily ==========');
  const bySeg = analytics.funnelBySegment({ userId: uid });
  console.log('segments:', bySeg.map(s => `${s.segment}: leads=${s.leads} contacted=${s.contacted} replied=${s.replied} positive=${s.positive}`).join(' | '));
  if (!bySeg.find(s => s.segment === 'fmcg' && s.positive === 1)) throw new Error('fmcg should have 1 positive');
  if (!bySeg.find(s => s.segment === 'education' && s.positive === 1)) throw new Error('education should have 1 positive');

  const ab = analytics.abPerformance({ userId: uid });
  console.log('A/B:', ab.map(r => `step${r.step_number}${r.variant_key}: sent=${r.sent} open%=${r.open_rate} reply%=${r.reply_rate} positive%=${r.positive_rate}`).join(' | '));
  if (!ab.find(r => r.step_number === 1 && r.variant_key === 'A' && r.sent === 3)) throw new Error('step1/A should have 3 sends (leads 0, 2, 4)');
  if (!ab.find(r => r.step_number === 1 && r.variant_key === 'B' && r.sent === 3)) throw new Error('step1/B should have 3 sends (leads 1, 3, 5)');

  const top = analytics.topMessages({ userId: uid, limit: 5 });
  console.log('top:', top.map(t => `step${t.step_number}${t.variant_key} ${t.lead_name} replied=${t.replied} class=${t.reply_class}`).join(' | '));
  if (!top.length) throw new Error('top messages empty');

  const daily = analytics.dailySeries({ userId: uid, days: 30 });
  console.log('daily rows:', daily.length);
  if (!daily.length) throw new Error('daily empty');

  const cost = analytics.aiCostSummary({ userId: uid });
  console.log('ai cost total:', cost.total.cost, 'calls:', cost.total.calls, 'by_task:', cost.by_task.map(t => t.task_type + '=' + t.cost.toFixed(4)).join(','));
  if (cost.total.calls !== 3) throw new Error('expected 3 AI cost entries');
  if (Math.abs(cost.total.cost - 0.0353) > 0.001) throw new Error('expected total cost ~0.0353, got ' + cost.total.cost);

  console.log('\n========== 4. Connectors ==========');
  const list = connectors.listConnectors(uid);
  console.log('adapters:', list.map(a => `${a.key}:${a.adapter_status}/${a.connection_status}`).join(' | '));
  if (list.length !== 5) throw new Error('expected 5 adapters');

  // Save LinkedIn cookie
  const linked = await connectors.upsertCredentials(uid, 'linkedin_sales_nav', { li_at_cookie: 'AQEDAQFakeCookieLongEnoughToPass' });
  console.log('linkedin connect:', linked);
  if (linked.status !== 'connected') throw new Error('linkedin should connect with valid-shaped cookie');

  // Bad linkedin (short cookie)
  const bad = await connectors.upsertCredentials(uid, 'linkedin_sales_nav', { li_at_cookie: 'short' });
  console.log('linkedin bad-cookie:', bad);
  if (bad.status !== 'error') throw new Error('short cookie should fail validation');

  // discover() should error honestly (scaffold)
  try {
    await connectors.runDiscovery(uid, 'linkedin_sales_nav', {});
    throw new Error('linkedin discover() should throw');
  } catch (err) {
    if (!err.message.includes('not yet wired')) throw new Error('unexpected error: ' + err.message);
    console.log('✓ linkedin discover() errors honestly:', err.message.slice(0, 80));
  }

  // Event list adapter — passthrough
  await connectors.upsertCredentials(uid, 'event_list', { event_name: 'BabyFair 2026', event_date: '2026-05' });
  const evt = await connectors.runDiscovery(uid, 'event_list', { contacts: [
    { name: 'Expo Alice', company: 'Alice Kids', email: 'alice@kids.my', linkedin_url: 'https://linkedin.com/in/alice' },
    { name: 'Expo Ben',   company: 'Ben Baby',  email: 'ben@baby.my',   linkedin_url: 'https://linkedin.com/in/ben' },
  ] });
  console.log('event list discover:', evt);
  if (evt.count !== 2) throw new Error('event list passthrough failed');

  console.log('\n✅ All Sprint 4 smoke checks passed.\n');
  process.exit(0);
}

main().catch(err => { console.error('❌', err.message); console.error(err.stack); process.exit(1); });
