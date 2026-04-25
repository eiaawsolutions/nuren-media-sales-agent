import db from '../db/index.js';
import { verifyLead } from './lead-verification.js';

/**
 * Canonical "unenriched" predicate. A lead has NO REACHABLE CONTACT when
 * all three of email / phone / linkedin profile are missing or known-fake.
 * Reused by:
 *   - listLeads() default search guard (drops them from results)
 *   - settings.js DB-cleanup preview + delete endpoints
 *
 * Pseudo-email hosts (@noemail.leads.local, @example.*) are treated as empty
 * because they came from the legacy AI Web Search path before strict mode and
 * are unreachable. Same for the literal string 'unknown'.
 */
export const UNENRICHED_WHERE_FRAGMENT = unenrichedFragment('');
const ENRICHED_WHERE_FRAGMENT = enrichedFragment('l');

/**
 * Build the "unenriched" SQL predicate against an arbitrary table alias.
 * Pass '' for unaliased columns, or 'l' / 'leads' / etc. for joined queries.
 */
export function unenrichedFragment(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `
    (${p}email IS NULL OR ${p}email = '' OR ${p}email LIKE '%@noemail.%' OR ${p}email LIKE '%@example.%' OR lower(${p}email) = 'unknown')
    AND (${p}phone IS NULL OR ${p}phone = '')
    AND (${p}linkedin_url IS NULL OR ${p}linkedin_url = '' OR ${p}linkedin_url NOT LIKE '%linkedin.com/in/%')
  `;
}

/**
 * Inverse predicate — lead HAS at least one reachable channel.
 */
export function enrichedFragment(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `
    (
      (${p}email IS NOT NULL AND ${p}email != '' AND ${p}email NOT LIKE '%@noemail.%' AND ${p}email NOT LIKE '%@example.%' AND lower(${p}email) != 'unknown')
      OR (${p}phone IS NOT NULL AND ${p}phone != '')
      OR (${p}linkedin_url IS NOT NULL AND ${p}linkedin_url LIKE '%linkedin.com/in/%')
    )
  `;
}

/**
 * Extract the canonical LinkedIn handle from a profile URL for dedup.
 * linkedin.com/in/FirdausH/  →  firdaush
 * www.linkedin.com/in/foo-bar?ref=x  →  foo-bar
 * Returns '' if the URL is not a /in/ profile.
 */
function linkedinHandle(url) {
  if (!url || typeof url !== 'string') return '';
  const m = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? m[1].toLowerCase().replace(/\/$/, '') : '';
}

/** Normalise a string into a slug for name/company fingerprints. */
function slug(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '').trim();
}

/**
 * Look up an existing lead by a layered dedup key. Returns the existing row
 * or null. Order of precedence (first match wins):
 *   1. Apollo ID (when source=apollo and enrichment has apollo_id)
 *   2. LinkedIn handle (canonical, case-insensitive)
 *   3. Email (exact, case-insensitive) — only when email is non-empty
 *   4. Name + company fingerprint fallback
 *
 * This covers the three real-world dup cases observed on prod (2026-04-24):
 *   - Same person, no email either time (email='' matches nothing)
 *   - Same person enriched twice with different email variants
 *   - Same person added manually and then again via Apollo
 */
function findExistingLead(userId, lead, source, raw) {
  // 1. Apollo ID — most reliable when available
  let apolloId = null;
  try {
    const enr = typeof lead.enrichment === 'object' ? lead.enrichment : (lead.enrichment ? JSON.parse(lead.enrichment) : null);
    apolloId = enr?.apollo_id || null;
  } catch {}
  if (apolloId) {
    const byApollo = db.prepare(`
      SELECT id FROM leads
      WHERE user_id = ? AND enrichment LIKE ?
      LIMIT 1
    `).get(userId, `%"apollo_id":"${apolloId}"%`);
    if (byApollo) return byApollo;
  }

  // 2. LinkedIn handle
  const handle = linkedinHandle(lead.linkedin_url);
  if (handle) {
    const byLinkedIn = db.prepare(`
      SELECT id FROM leads
      WHERE user_id = ?
        AND linkedin_url LIKE ?
      LIMIT 1
    `).get(userId, `%/in/${handle}%`);
    if (byLinkedIn) return byLinkedIn;
  }

  // 3. Email (only when non-empty)
  if (lead.email) {
    const byEmail = db.prepare('SELECT id FROM leads WHERE user_id = ? AND lower(email) = lower(?)').get(userId, lead.email);
    if (byEmail) return byEmail;
  }

  // 4. Name + company fingerprint (last resort — catches manual CSV dups)
  const nameKey = slug(lead.name);
  const companyKey = slug(lead.company || raw?.company || '');
  if (nameKey && companyKey) {
    const byNameCompany = db.prepare(`
      SELECT l.id FROM leads l LEFT JOIN accounts a ON a.id = l.account_id
      WHERE l.user_id = ?
        AND lower(replace(replace(l.name, ' ', ''), '-', '')) = ?
        AND lower(replace(replace(COALESCE(a.name, ''), ' ', ''), '-', '')) LIKE ?
      LIMIT 1
    `).get(userId, nameKey, `%${companyKey}%`);
    if (byNameCompany) return byNameCompany;
  }

  return null;
}

/**
 * Persist a verified lead. Runs the verification gate again defensively — the
 * same function used at enrichment time — so even manual CSV uploads cannot
 * sneak Low-confidence rows into the leads table.
 *
 * Auto-creates/links an `accounts` row when `company` is present.
 * Dedup: layered key (apollo_id → linkedin_handle → email → name+company).
 *   When a match is found, the existing row is UPDATED with the new data
 *   and the return payload carries `updated: true`. Never inserts a dup.
 *
 * Returns { ok, lead_id?, account_id?, updated?, reasons?, rejected_id? }.
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

  // Layered dedup — see findExistingLead() for the precedence. If a match is
  // found we UPDATE that row with the new fields instead of inserting a dup.
  let lead_id;
  const existingLead = findExistingLead(userId, lead, source, raw);

  if (existingLead) {
    // Upsert path. COALESCE preserves existing values when the new row has
    // nothing to add — e.g. Apollo re-ingest with no email won't blank out
    // an email that was captured manually earlier.
    db.prepare(`
      UPDATE leads SET
        account_id = COALESCE(?, account_id),
        name = COALESCE(NULLIF(?, ''), name),
        title = COALESCE(NULLIF(?, ''), title),
        email = COALESCE(NULLIF(?, ''), email),
        phone = COALESCE(NULLIF(?, ''), phone),
        other_contact = COALESCE(NULLIF(?, ''), other_contact),
        persona = ?, type = ?,
        lead_type = ?, confidence_score = ?,
        linkedin_url = COALESCE(NULLIF(?, ''), linkedin_url),
        company_website = COALESCE(NULLIF(?, ''), company_website),
        verification_sources = ?, reason_for_fit = ?, buying_signal = ?,
        enrichment = ?, source = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      account_id,
      lead.name || '', lead.title || '',
      lead.email || '', lead.phone || '', lead.other_contact || '',
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

export function listLeads(userId, { status, persona, lead_type, search, limit = 100, offset = 0, require_contact } = {}) {
  const where = ['l.user_id = ?'];
  const params = [userId];
  if (status) { where.push('l.status = ?'); params.push(status); }
  if (persona) { where.push('l.persona = ?'); params.push(persona); }
  if (lead_type) { where.push('l.lead_type = ?'); params.push(lead_type); }
  // Default ON: drop leads with no reachable contact (no real email,
  // no phone, no linkedin /in/ profile). Pass require_contact=0 to opt out
  // when debugging the rejected pipeline.
  const requireContact = require_contact === undefined || require_contact === '1' || require_contact === 1 || require_contact === true;
  if (requireContact) where.push(ENRICHED_WHERE_FRAGMENT);
  if (search) {
    where.push('(l.name LIKE ? OR l.email LIKE ? OR a.name LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  const sql = `
    SELECT l.id, l.name, l.email, l.title, l.persona, l.type, l.lead_type, l.confidence_score, l.score,
           l.status, l.source, l.linkedin_url, l.company_website, l.buying_signal, l.enrichment, l.created_at,
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
