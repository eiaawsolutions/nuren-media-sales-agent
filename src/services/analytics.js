import db from '../db/index.js';

/**
 * Read-only analytics layer. All queries scoped to a user_id (superadmin omits
 * the scope and sees org-wide). Every stat here maps to a concrete KPI in the
 * requirements doc: open / reply / positive_reply / meeting_booked / revenue_per_lead.
 *
 * All rates are computed on the live data — no materialized views, since the
 * message + activity tables are small and bm25/sql is fast enough at
 * agency/enterprise scale (< 1M rows per tenant).
 */

function uf(userId) { return userId ? ' AND user_id = ? ' : ''; }
function uf2(userId, alias) { return userId ? ` AND ${alias}.user_id = ? ` : ''; }
function params(userId) { return userId ? [userId] : []; }

/**
 * Classic inside-sales funnel:
 *   leads_total -> contacted (sent ≥1) -> opened -> clicked -> replied
 *   -> positive_replies -> meetings_booked -> closed_won (+ revenue)
 */
export function funnel({ userId, from, to } = {}) {
  const time = buildTimeRange(from, to);
  const timeSql = time.sql ? ` AND ${time.sql} ` : '';
  const timeParams = time.params;

  const leads_total = db.prepare(
    `SELECT COUNT(*) c FROM leads WHERE 1=1 ${uf(userId)}`
  ).get(...params(userId)).c;

  // contacted = leads that received at least one outbound send
  const contacted = db.prepare(
    `SELECT COUNT(DISTINCT m.lead_id) c FROM messages m
     JOIN leads l ON l.id = m.lead_id
     WHERE m.direction='outbound' AND m.status IN ('sent','delivered','opened','clicked','replied','bounced')
     ${uf2(userId, 'l')} ${timeSql.replace(/user_id/g, 'l.user_id')}`
  ).get(...params(userId), ...timeParams).c;

  const opened = db.prepare(
    `SELECT COUNT(DISTINCT m.lead_id) c FROM messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.direction='outbound' AND m.opened_at IS NOT NULL ${uf2(userId, 'l')} ${timeSql.replace(/created_at/g, 'm.opened_at')}`
  ).get(...params(userId), ...timeParams).c;

  const clicked = db.prepare(
    `SELECT COUNT(DISTINCT m.lead_id) c FROM messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.direction='outbound' AND m.clicked_at IS NOT NULL ${uf2(userId, 'l')} ${timeSql.replace(/created_at/g, 'm.clicked_at')}`
  ).get(...params(userId), ...timeParams).c;

  const replied = db.prepare(
    `SELECT COUNT(DISTINCT m.lead_id) c FROM messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.direction='inbound' ${uf2(userId, 'l')} ${timeSql.replace(/created_at/g, 'm.created_at')}`
  ).get(...params(userId), ...timeParams).c;

  const positive = db.prepare(
    `SELECT COUNT(DISTINCT m.lead_id) c FROM messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.direction='inbound' AND m.classification='positive' ${uf2(userId, 'l')} ${timeSql.replace(/created_at/g, 'm.created_at')}`
  ).get(...params(userId), ...timeParams).c;

  const meetings_booked = db.prepare(
    `SELECT COUNT(*) c FROM appointments WHERE 1=1 ${uf(userId)} ${timeSql}`
  ).get(...params(userId), ...timeParams).c;

  const meetings_held = db.prepare(
    `SELECT COUNT(*) c FROM appointments WHERE status='completed' ${uf(userId)} ${timeSql}`
  ).get(...params(userId), ...timeParams).c;

  const closed_won_row = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(deal_value_myr),0) AS value FROM pipeline WHERE stage='closed_won' ${uf(userId)} ${timeSql.replace(/created_at/g, 'updated_at')}`
  ).get(...params(userId), ...timeParams);

  const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;

  return {
    leads_total,
    contacted,
    opened,
    clicked,
    replied,
    positive_replies: positive,
    meetings_booked,
    meetings_held,
    closed_won: closed_won_row.c,
    revenue_myr: closed_won_row.value,
    rates: {
      contact_rate: pct(contacted, leads_total),
      open_rate: pct(opened, contacted),
      click_rate: pct(clicked, contacted),
      reply_rate: pct(replied, contacted),
      positive_reply_rate: pct(positive, contacted),
      meeting_booked_rate: pct(meetings_booked, contacted),
      positive_to_meeting: pct(meetings_booked, positive),
      meeting_to_won: pct(closed_won_row.c, meetings_booked),
      revenue_per_contacted_myr: contacted ? +(closed_won_row.value / contacted).toFixed(2) : 0,
    },
  };
}

/**
 * Per-segment funnel — reveals where Nuren converts best.
 * Segments come from `accounts.industry` (fmcg/healthcare/education/ecommerce/other).
 */
export function funnelBySegment({ userId } = {}) {
  const rows = db.prepare(`
    SELECT
      COALESCE(a.industry, 'unknown') AS segment,
      COUNT(DISTINCT l.id) AS leads,
      COUNT(DISTINCT CASE WHEN m.direction='outbound' AND m.status IN ('sent','delivered','opened','clicked','replied','bounced') THEN l.id END) AS contacted,
      COUNT(DISTINCT CASE WHEN m.direction='outbound' AND m.opened_at IS NOT NULL THEN l.id END) AS opened,
      COUNT(DISTINCT CASE WHEN m.direction='inbound' THEN l.id END) AS replied,
      COUNT(DISTINCT CASE WHEN m.direction='inbound' AND m.classification='positive' THEN l.id END) AS positive,
      COUNT(DISTINCT ap.id) AS meetings
    FROM leads l
    LEFT JOIN accounts a ON a.id = l.account_id
    LEFT JOIN messages m ON m.lead_id = l.id
    LEFT JOIN appointments ap ON ap.lead_id = l.id
    WHERE 1=1 ${uf2(userId, 'l')}
    GROUP BY segment
    ORDER BY replied DESC, contacted DESC
  `).all(...params(userId));
  const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;
  return rows.map(r => ({
    ...r,
    open_rate: pct(r.opened, r.contacted),
    reply_rate: pct(r.replied, r.contacted),
    positive_rate: pct(r.positive, r.contacted),
    meeting_rate: pct(r.meetings, r.contacted),
  }));
}

/**
 * Best-performing messages — grouped by (step_number, variant_key). Shows send
 * counts, open rate, reply rate, positive reply rate. Used to identify A/B winners.
 */
export function abPerformance({ userId, campaignId } = {}) {
  const campaignFilter = campaignId ? ' AND m.campaign_id = ? ' : '';
  const userFilter = userId ? ' AND l.user_id = ? ' : '';
  const p = [];
  if (campaignId) p.push(campaignId);
  if (userId) p.push(userId);

  const rows = db.prepare(`
    SELECT
      m.step_number, m.variant_key,
      COUNT(*) AS sent,
      SUM(CASE WHEN m.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      SUM(CASE WHEN m.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
      SUM(CASE WHEN m.replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
      SUM(CASE WHEN m.status='bounced' THEN 1 ELSE 0 END) AS bounced
    FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE m.direction='outbound' AND m.status NOT IN ('drafted','queued','failed')
      ${campaignFilter} ${userFilter}
    GROUP BY m.step_number, m.variant_key
    ORDER BY m.step_number, m.variant_key
  `).all(...p);

  const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;
  // Compute positive replies per (step,variant) via separate join
  const positives = db.prepare(`
    SELECT out.step_number, out.variant_key, COUNT(DISTINCT out.lead_id) AS positive
    FROM messages out
    JOIN messages inb ON inb.lead_id = out.lead_id AND inb.direction='inbound' AND inb.classification='positive'
    JOIN leads l ON l.id = out.lead_id
    WHERE out.direction='outbound' ${campaignFilter.replace(/m\./g, 'out.')} ${userFilter}
    GROUP BY out.step_number, out.variant_key
  `).all(...p);
  const posMap = {};
  for (const r of positives) posMap[`${r.step_number}:${r.variant_key}`] = r.positive;

  return rows.map(r => ({
    ...r,
    positive: posMap[`${r.step_number}:${r.variant_key}`] || 0,
    open_rate: pct(r.opened, r.sent),
    click_rate: pct(r.clicked, r.sent),
    reply_rate: pct(r.replied, r.sent),
    positive_rate: pct(posMap[`${r.step_number}:${r.variant_key}`] || 0, r.sent),
    bounce_rate: pct(r.bounced, r.sent),
  }));
}

/** Top individual messages by positive-reply attribution — leaderboard for copy inspiration. */
export function topMessages({ userId, limit = 10 } = {}) {
  return db.prepare(`
    SELECT m.id, m.step_number, m.variant_key, m.subject,
           SUBSTR(m.body, 1, 200) AS body_preview,
           l.name AS lead_name, l.persona, a.industry,
           m.sent_at, m.opened_at, m.replied_at,
           CASE WHEN m.replied_at IS NOT NULL THEN 1 ELSE 0 END AS replied,
           (SELECT classification FROM messages rpl WHERE rpl.lead_id=m.lead_id AND rpl.direction='inbound' AND rpl.created_at > m.sent_at ORDER BY rpl.created_at LIMIT 1) AS reply_class
    FROM messages m JOIN leads l ON l.id = m.lead_id
    LEFT JOIN accounts a ON a.id = l.account_id
    WHERE m.direction='outbound' AND m.status IN ('sent','delivered','opened','clicked','replied')
      ${userId ? ' AND l.user_id = ?' : ''}
    ORDER BY (CASE WHEN m.replied_at IS NOT NULL THEN 2 ELSE 0 END)
           + (CASE WHEN m.opened_at IS NOT NULL THEN 1 ELSE 0 END) DESC,
           m.sent_at DESC
    LIMIT ?
  `).all(...(userId ? [userId, limit] : [limit]));
}

/** Daily sends + daily replies for the last N days (for a sparkline). */
export function dailySeries({ userId, days = 14 } = {}) {
  const sql = `
    SELECT date(m.sent_at) AS day,
           SUM(CASE WHEN m.direction='outbound' AND m.sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN m.direction='outbound' AND m.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
           SUM(CASE WHEN m.direction='inbound' THEN 1 ELSE 0 END) AS replied
    FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE m.sent_at >= datetime('now', ?) ${userId ? ' AND l.user_id = ?' : ''}
    GROUP BY date(m.sent_at)
    ORDER BY day
  `;
  const p = [`-${days} days`];
  if (userId) p.push(userId);
  return db.prepare(sql).all(...p);
}

/** AI cost snapshot for the billing / budget overview. */
export function aiCostSummary({ userId } = {}) {
  const p = userId ? [userId] : [];
  const uf = userId ? ' WHERE user_id = ? ' : '';
  const ufA = userId ? ' AND user_id = ? ' : '';
  const total = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(total_tokens),0) AS tokens, COUNT(*) AS calls FROM ai_cost_log ${uf}`).get(...p);
  const this_month = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS calls FROM ai_cost_log WHERE created_at >= datetime('now','start of month') ${ufA}`).get(...p);
  const by_task = db.prepare(`SELECT task_type, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost FROM ai_cost_log ${uf} GROUP BY task_type ORDER BY cost DESC`).all(...p);
  const by_model = db.prepare(`SELECT model, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost FROM ai_cost_log ${uf} GROUP BY model ORDER BY cost DESC`).all(...p);
  return { total, this_month, by_task, by_model };
}

function buildTimeRange(from, to) {
  const parts = [], params = [];
  if (from) { parts.push('created_at >= ?'); params.push(from); }
  if (to)   { parts.push('created_at <= ?'); params.push(to); }
  return { sql: parts.join(' AND '), params };
}
