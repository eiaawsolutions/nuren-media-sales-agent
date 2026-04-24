import db from '../db/index.js';
import { verifyLead } from './lead-verification.js';

/**
 * Persist a verified lead. Runs the verification gate again defensively — the
 * same function used at enrichment time — so even manual CSV uploads cannot
 * sneak Low-confidence rows into the leads table.
 *
 * Auto-creates/links an `accounts` row when `company` is present.
 * Returns { ok, lead_id?, account_id?, reasons?, rejected_id? }.
 */
export function persistLead(raw, { userId, source = 'manual' }) {
  const { ok, reasons, lead } = verifyLead(raw);
  if (!ok) {
    const r = db.prepare(
      "INSERT INTO leads_rejected (user_id, raw_input, reasons, source) VALUES (?, ?, ?, ?)"
    ).run(userId, JSON.stringify(raw), JSON.stringify(reasons), source);
    return { ok: false, reasons, rejected_id: Number(r.lastInsertRowid) };
  }

  // Account rollup (create-or-match by user_id + website || name)
  let account_id = null;
  const company = (raw.company || '').trim();
  const website = (lead.company_website || '').trim();
  if (company || website) {
    let existing = null;
    if (website) existing = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND website = ?').get(userId, website);
    if (!existing && company) existing = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND lower(name) = lower(?)').get(userId, company);
    if (existing) account_id = existing.id;
    else {
      const ins = db.prepare(
        "INSERT INTO accounts (user_id, name, website, industry, sub_industry, geography, estimated_budget_tier) VALUES (?,?,?,?,?,?,?)"
      ).run(
        userId,
        company || extractDomain(website) || 'Unknown',
        website || null,
        (lead.industry || 'other').toLowerCase(),
        lead.sub_industry || null,
        lead.geography || null,
        'unknown'
      );
      account_id = Number(ins.lastInsertRowid);
    }
  }

  // Upsert by (user_id, email) when email present. If email is '', always insert (anonymous lead).
  let lead_id;
  const existingLead = lead.email ? db.prepare('SELECT id FROM leads WHERE user_id = ? AND email = ?').get(userId, lead.email) : null;

  if (existingLead) {
    db.prepare(`
      UPDATE leads SET
        account_id = COALESCE(?, account_id),
        name = ?, title = ?, phone = ?, other_contact = ?,
        persona = ?, type = ?,
        lead_type = ?, confidence_score = ?,
        linkedin_url = ?, company_website = ?,
        verification_sources = ?, reason_for_fit = ?, buying_signal = ?,
        enrichment = ?, source = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      account_id,
      lead.name, lead.title || null, lead.phone || '', lead.other_contact || '',
      (lead.persona || 'unknown'), (lead.type || 'B2B'),
      (lead.lead_type || 'cold'), (lead.confidence_score || 'medium'),
      lead.linkedin_url || '', lead.company_website || '',
      JSON.stringify(lead.verification_sources || []), lead.reason_for_fit || '', lead.buying_signal || '',
      JSON.stringify(lead.enrichment || {}), source,
      existingLead.id
    );
    lead_id = existingLead.id;
  } else {
    const ins = db.prepare(`
      INSERT INTO leads (
        user_id, account_id, name, title, email, phone, other_contact,
        persona, type, lead_type, confidence_score, score,
        linkedin_url, company_website, verification_sources, reason_for_fit, buying_signal,
        enrichment, status, source
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      userId, account_id,
      lead.name, lead.title || null, lead.email || '', lead.phone || '', lead.other_contact || '',
      (lead.persona || 'unknown'), (lead.type || 'B2B'), (lead.lead_type || 'cold'),
      (lead.confidence_score || 'medium'), scoreLead(lead),
      lead.linkedin_url || '', lead.company_website || '',
      JSON.stringify(lead.verification_sources || []), lead.reason_for_fit || '', lead.buying_signal || '',
      JSON.stringify(lead.enrichment || {}), 'new', source
    );
    lead_id = Number(ins.lastInsertRowid);
  }

  db.prepare(
    "INSERT INTO activities (user_id, lead_id, account_id, type, description, meta) VALUES (?,?,?,?,?,?)"
  ).run(userId, lead_id, account_id, 'lead_enriched', `Lead ${existingLead ? 'updated' : 'added'} via ${source}: ${lead.name}`, JSON.stringify({ source }));

  return { ok: true, lead_id, account_id, updated: !!existingLead };
}

export function getLead(id, userId) {
  const lead = db.prepare(`
    SELECT l.*, a.name AS account_name, a.website AS account_website, a.industry AS account_industry
    FROM leads l LEFT JOIN accounts a ON a.id = l.account_id
    WHERE l.id = ? AND l.user_id = ?
  `).get(id, userId);
  if (!lead) return null;
  try { lead.verification_sources = JSON.parse(lead.verification_sources || '[]'); } catch { lead.verification_sources = []; }
  try { lead.enrichment = JSON.parse(lead.enrichment || '{}'); } catch { lead.enrichment = {}; }
  return lead;
}

export function listLeads(userId, { status, persona, lead_type, search, limit = 100, offset = 0 } = {}) {
  const where = ['l.user_id = ?'];
  const params = [userId];
  if (status) { where.push('l.status = ?'); params.push(status); }
  if (persona) { where.push('l.persona = ?'); params.push(persona); }
  if (lead_type) { where.push('l.lead_type = ?'); params.push(lead_type); }
  if (search) {
    where.push('(l.name LIKE ? OR l.email LIKE ? OR a.name LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  const sql = `
    SELECT l.id, l.name, l.email, l.title, l.persona, l.type, l.lead_type, l.confidence_score, l.score,
           l.status, l.source, l.linkedin_url, l.company_website, l.buying_signal, l.created_at,
           a.name AS account_name, a.industry AS account_industry
    FROM leads l LEFT JOIN accounts a ON a.id = l.account_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function scoreLead(lead) {
  // 0-100 score used for sorting. Simple heuristic; tune later.
  let s = 40;
  if (lead.confidence_score === 'high') s += 20;
  else if (lead.confidence_score === 'low') s -= 20;
  if (lead.lead_type === 'hot') s += 25;
  if (lead.persona === 'marketing_manager' || lead.persona === 'brand_manager' || lead.persona === 'digital_marketer') s += 5;
  if (lead.persona === 'founder') s += 3;
  if (lead.linkedin_url) s += 5;
  if ((lead.verification_sources || []).length >= 2) s += 5;
  return Math.max(0, Math.min(100, s));
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
