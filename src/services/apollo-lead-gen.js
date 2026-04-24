import { getSetting, logAICost, checkBudget } from '../utils/anthropic.js';
import { decrypt } from '../utils/crypto.js';
import { verifyLead } from './lead-verification.js';
import { persistLead } from './leads.js';
import db from '../db/index.js';

/**
 * Apollo.io lead generation (Path C — runs alongside Claude web_search).
 *
 * Apollo's API has a two-step architecture that we mirror here:
 *
 *   1. POST /api/v1/mixed_people/api_search
 *      — Structured search by title, seniority, location, company size.
 *      — Returns candidate records WITHOUT email or phone.
 *      — Does NOT consume Apollo credits.
 *
 *   2. POST /api/v1/people/match  (one call per candidate we want to keep)
 *      — Enriches a single person by apollo id (or linkedin_url, email, etc.)
 *      — With reveal_personal_emails:true + reveal_phone_number:true,
 *        returns the verified email and any available phone numbers.
 *      — CONSUMES Apollo credits per reveal.
 *
 * Every enriched lead passes through the same verifyLead() gate as CSV and
 * AI-generated paths. Because Apollo always returns a real linkedin.com/in/
 * URL and a company domain, leads almost always satisfy the 2-source rule.
 *
 * Reference docs (verified 2026-04-24):
 *   https://docs.apollo.io/reference/people-api-search
 *   https://docs.apollo.io/reference/people-enrichment
 */

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const MAX_LEADS_PER_CALL = 15;
const APOLLO_CREDIT_COST_USD = 0.05; // rough per-enrichment estimate; actual cost comes from Apollo billing

export async function generateLeadsViaApollo({ userId, campaignId, count = 5 }) {
  const numLeads = Math.min(Math.max(parseInt(count, 10) || 5, 1), MAX_LEADS_PER_CALL);

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(campaignId, userId);
  if (!campaign) throw new Error('Campaign not found');

  checkBudget(campaignId);

  const apiKey = getApolloKey();
  if (!apiKey) {
    const e = new Error('Apollo API key not configured. Go to Settings → apollo_api_key and paste your key from https://app.apollo.io/#/settings/integrations/api');
    e.code = 'apollo_not_configured';
    throw e;
  }

  const filters = buildApolloFilters(campaign);
  const searchBody = {
    ...filters,
    page: 1,
    per_page: numLeads,
  };

  // Step 1 — zero-credit structured search. Returns candidate records with
  // id/name/title/company (obfuscated last_name, no email/phone/linkedin).
  console.log(`[apollo-lead-gen] START campaignId=${campaignId} requested=${numLeads} filters=${JSON.stringify(filters)}`);
  let searchResponse;
  try {
    searchResponse = await apolloFetch('/mixed_people/api_search', apiKey, searchBody);
  } catch (err) {
    throw rewriteApolloError(err);
  }

  const candidates = Array.isArray(searchResponse?.people) ? searchResponse.people : [];
  console.log(`[apollo-lead-gen] search returned ${candidates.length} candidates (total_entries=${searchResponse?.total_entries})`);

  if (candidates.length === 0) {
    return { generated: 0, rejected: 0, rejected_cold: 0, source: 'apollo', requested: numLeads, total_returned: 0, enrichment_calls: 0, leads: [], rejections: [] };
  }

  // Step 2 — enrichment. Single-enrich (/people/match) for count=1, bulk-enrich
  // (/people/bulk_match) for count>1. Bulk is 1 API call regardless of batch
  // size, halving latency vs sequential single-enrich; credit cost is identical.
  const enrichedPeople = [];
  let enrichmentCalls = 0;
  if (candidates.length === 1) {
    try {
      const resp = await apolloFetch('/people/match', apiKey, {
        id: candidates[0].id,
        reveal_personal_emails: true,
      });
      enrichmentCalls = 1;
      enrichedPeople.push(resp?.person || resp);
      console.log('[apollo-lead-gen] single-enrich complete');
    } catch (err) {
      throw rewriteApolloError(err);
    }
  } else {
    try {
      const resp = await apolloFetch('/people/bulk_match', apiKey, {
        reveal_personal_emails: true,
        details: candidates.map(c => ({ id: c.id })),
      });
      enrichmentCalls = 1; // 1 API call for N enrichments (billed per-person server-side)
      const matches = Array.isArray(resp?.matches) ? resp.matches : [];
      enrichedPeople.push(...matches);
      console.log(`[apollo-lead-gen] bulk-enrich complete: ${matches.length}/${candidates.length} matched`);
    } catch (err) {
      throw rewriteApolloError(err);
    }
  }

  // Apollo bills credits per-person-enriched, not per-API-call. So cost scales
  // with enrichedPeople.length even when we made a single bulk_match call.
  const creditsConsumed = enrichedPeople.length;
  logAICost({
    userId,
    campaignId,
    taskType: 'apollo_lead_gen',
    model: 'apollo.io',
    inputTokens: 0,
    outputTokens: 0,
    webSearchRequests: 0,
    costOverride: creditsConsumed * APOLLO_CREDIT_COST_USD,
  });

  const accepted = [];
  const rejected = [];
  let rejectedCold = 0;
  const seenInBatch = new Set();
  const existingEmails = db.prepare("SELECT email FROM leads WHERE user_id = ? AND email != ''").all(userId).map(r => r.email.toLowerCase());

  for (const person of enrichedPeople) {
    const candidate = apolloPersonToLead(person, campaign);

    const emailKey = (candidate.email || '').toLowerCase().trim();
    if (emailKey) {
      if (seenInBatch.has(emailKey)) { rejected.push({ name: candidate.name, reasons: ['duplicate_in_batch'] }); continue; }
      if (existingEmails.includes(emailKey)) { rejected.push({ name: candidate.name, reasons: ['duplicate_with_existing'] }); continue; }
      seenInBatch.add(emailKey);
    }

    // Hot-lead vetting (only-hot policy set 2026-04-24). Lead must:
    //   1. Have a verified email (Apollo email_status === 'verified')
    //   2. Be at decision-maker seniority (manager, director, head, vp, c_suite, founder, owner)
    //   3. Fire at least one buying signal (fresh role OR org-size-fit)
    // Cold leads are not persisted. Rejection reasons are logged to
    // leads_rejected for audit, but the count surfaces separately as
    // rejected_cold so the UI can explain the vetting.
    const hotVerdict = classifyHotness(person);
    if (!hotVerdict.hot) {
      rejectedCold++;
      db.prepare("INSERT INTO leads_rejected (user_id, raw_input, reasons, source) VALUES (?,?,?,?)")
        .run(userId, JSON.stringify(person), JSON.stringify(['cold:' + hotVerdict.reason]), 'apollo');
      rejected.push({ name: candidate.name, reasons: ['cold:' + hotVerdict.reason] });
      continue;
    }
    // Override lead_type + buying_signal with what the vetter found.
    candidate.lead_type = 'hot';
    candidate.buying_signal = hotVerdict.signal;

    const gate = verifyLead(candidate);
    if (!gate.ok) {
      db.prepare("INSERT INTO leads_rejected (user_id, raw_input, reasons, source) VALUES (?,?,?,?)")
        .run(userId, JSON.stringify(person), JSON.stringify(gate.reasons), 'apollo');
      rejected.push({ name: candidate.name, reasons: gate.reasons });
      continue;
    }

    const persistResult = persistLead(gate.lead, { userId, source: 'apollo' });
    if (!persistResult.ok) {
      rejected.push({ name: candidate.name, reasons: persistResult.reasons });
      continue;
    }

    ensureCampaignLeadsTable();
    db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaignId, persistResult.lead_id);

    accepted.push({
      id: persistResult.lead_id,
      name: gate.lead.name,
      title: gate.lead.title,
      company: gate.lead.company,
      lead_type: gate.lead.lead_type,
      confidence_score: gate.lead.confidence_score,
      buying_signal: gate.lead.buying_signal,
    });
  }

  console.log(`[apollo-lead-gen] DONE persisted=${accepted.length} rejected_total=${rejected.length} rejected_cold=${rejectedCold} credits=${creditsConsumed}`);

  return {
    generated: accepted.length,
    rejected: rejected.length,
    rejected_cold: rejectedCold,
    source: 'apollo',
    requested: numLeads,
    total_returned: candidates.length,
    enrichment_calls: enrichmentCalls,
    credits_consumed: creditsConsumed,
    leads: accepted,
    rejections: rejected,
  };
}

/**
 * Hot-lead classifier. A lead qualifies as HOT for Nuren when:
 *   - Email is Apollo-verified (email_status === 'verified')
 *   - Seniority is decision-maker tier (not entry/intern/individual contributor)
 *   - At least one buying signal fires:
 *       A. Started in current role within the last 90 days (fresh mandate)
 *       B. Organization size 10-500 employees (Nuren's sweet spot)
 *       C. Current employment is active (has no end_date on current role)
 *
 * Returns { hot: boolean, signal: string | null, reason: string | null }.
 * `signal` becomes the buying_signal on accepted leads. `reason` becomes the
 * rejection tag on discarded cold leads.
 */
const HOT_SENIORITIES = new Set(['manager', 'director', 'head', 'vp', 'c_suite', 'founder', 'owner', 'partner']);

function classifyHotness(person) {
  // Hygiene prerequisite — no verified email means can't do cold outreach anyway
  if ((person.email_status || '').toLowerCase() !== 'verified') {
    return { hot: false, reason: 'no_verified_email' };
  }

  // Seniority gate
  const seniority = (person.seniority || '').toLowerCase();
  if (seniority && !HOT_SENIORITIES.has(seniority)) {
    return { hot: false, reason: `seniority_too_junior:${seniority}` };
  }

  // Try to fire at least one buying signal
  const signals = [];

  // Signal A — fresh role start
  const history = Array.isArray(person.employment_history) ? person.employment_history : [];
  const currentRole = history.find(h => h.current) || history[0];
  if (currentRole?.start_date) {
    const days = (Date.now() - new Date(currentRole.start_date).getTime()) / 86400000;
    if (days >= 0 && days <= 90) signals.push(`fresh_mandate:${Math.round(days)}d_in_role`);
  }

  // Signal B — org size sweet spot
  const empCount = person.organization?.estimated_num_employees;
  if (typeof empCount === 'number' && empCount >= 10 && empCount <= 500) {
    signals.push(`org_size_fit:${empCount}_employees`);
  }

  // Signal C — active current role (has no end_date on current employment)
  if (currentRole?.current && !currentRole.end_date) {
    signals.push('active_role');
  }

  if (signals.length === 0) {
    return { hot: false, reason: 'no_buying_signals' };
  }

  // Prefer fresh mandate > org size fit > active role for the buying_signal string
  const best = signals.find(s => s.startsWith('fresh_mandate'))
            || signals.find(s => s.startsWith('org_size_fit'))
            || signals[0];
  return { hot: true, signal: best, reason: null };
}

function getApolloKey() {
  const raw = getSetting('apollo_api_key', '');
  if (!raw) return null;
  return decrypt(raw);
}

/**
 * Compose Apollo search filters from a Nuren campaign. Only fields that are
 * documented in Apollo's people-api-search reference are used here — earlier
 * drafts had an undocumented `q_organization_keyword_tags` that caused 422s.
 *
 *   target_persona     → person_titles + person_seniorities (documented)
 *   target_budget_tier → organization_num_employees_ranges (documented)
 *   geography          → person_locations (documented, MY/SG/TH default)
 *
 * Industry filtering is intentionally dropped — Apollo's industry taxonomy
 * requires specific organization_industry_tag_ids which we don't have a
 * canonical list for, and the free-text industry keyword field is not part
 * of the public search schema. Operators narrow via target_persona instead.
 */
function buildApolloFilters(campaign) {
  const f = {};

  // Titles — Apollo accepts an array; we include synonyms so a campaign targeting
  // "brand_manager" also surfaces "senior brand manager", "brand lead", etc.
  const personaTitles = expandPersonaToTitles(campaign.target_persona);
  if (personaTitles.length) f.person_titles = personaTitles;

  // Seniorities — if we can infer from persona, narrow further for precision
  const seniorities = inferSeniorities(campaign.target_persona);
  if (seniorities.length) f.person_seniorities = seniorities;

  // Geography — Nuren's primary universe is MY/SG/TH; allow override via notes field
  f.person_locations = ['Malaysia', 'Singapore', 'Thailand'];

  // Company size — coarse mapping from budget tier to employee range
  const sizeRanges = mapBudgetTierToEmployeeRanges(campaign.target_budget_tier);
  if (sizeRanges.length) f.organization_num_employees_ranges = sizeRanges;

  return f;
}

function expandPersonaToTitles(persona) {
  const map = {
    brand_manager: ['Brand Manager', 'Brand Lead', 'Senior Brand Manager', 'Assistant Brand Manager', 'Group Brand Manager'],
    marketing_manager: ['Marketing Manager', 'Head of Marketing', 'Marketing Director', 'CMO', 'Chief Marketing Officer'],
    digital_marketer: ['Digital Marketing Manager', 'Performance Marketing Manager', 'Growth Manager', 'E-commerce Manager', 'Digital Marketing Director'],
    founder: ['Founder', 'Co-Founder', 'CEO', 'Managing Director', 'Owner'],
    // Fallback — if persona is unknown or free-text, just search broadly
  };
  return map[persona] || ['Marketing Manager', 'Brand Manager', 'Digital Marketing Manager', 'Founder'];
}

function inferSeniorities(persona) {
  // Apollo seniorities: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern
  const map = {
    founder: ['founder', 'owner', 'c_suite'],
    marketing_manager: ['head', 'director', 'manager', 'vp'],
    brand_manager: ['manager', 'senior', 'head'],
    digital_marketer: ['manager', 'director', 'head'],
  };
  return map[persona] || ['manager', 'director', 'head'];
}

function mapBudgetTierToEmployeeRanges(tier) {
  const map = {
    low: ['1,10', '11,50'],
    mid: ['51,200', '201,500'],
    high: ['501,1000', '1001,5000', '5001,10000', '10001'],
    any: [],
  };
  return map[tier] || [];
}

/**
 * Shape an Apollo /people/search result into the canonical lead object
 * verifyLead() expects. Apollo's person schema is rich — we only map fields
 * the verification gate + persistence layer care about.
 */
function apolloPersonToLead(person, campaign) {
  const name = person.name || [person.first_name, person.last_name].filter(Boolean).join(' ').trim();
  const company = person.organization?.name || person.account?.name || '';
  const companyWebsite = person.organization?.website_url || person.organization?.primary_domain || '';
  const linkedinUrl = person.linkedin_url || '';
  const title = person.title || '';

  // Apollo returns phone numbers in `phone_numbers` array; prefer mobile, then work.
  const phones = Array.isArray(person.phone_numbers) ? person.phone_numbers : [];
  const phone = phones.find(p => p.type === 'mobile')?.raw_number
             || phones.find(p => p.type === 'work')?.raw_number
             || phones[0]?.raw_number
             || '';

  // Apollo returns verified emails on Pro plans; others may be '' or locked.
  const email = person.email || '';

  // Verification sources — Apollo itself doesn't expose a public URL per record,
  // so we cite the LinkedIn URL + the company website. Both independent hosts,
  // satisfies the >=2 sources + distinct hosts rule.
  const verification_sources = [linkedinUrl, companyWebsite].filter(u => /^https?:\/\//i.test(u));

  // Location — Apollo fields: person.city, person.state, person.country
  const geoBits = [person.city, person.state, person.country].filter(Boolean);
  const geography = geoBits.join(', ');

  // lead_type and buying_signal are owned by classifyHotness() in the main flow;
  // we default to cold here and let the classifier override both fields on
  // accepted hot leads. This keeps a single source of truth for hotness rules.
  const buyingSignal = '';
  const leadType = 'cold';

  return {
    name,
    type: 'B2B',
    title,
    company,
    persona: campaign.target_persona || inferPersonaFromTitle(title),
    geography,
    industry: campaign.target_industry || 'other',
    sub_industry: '',
    email,
    phone,
    other_contact: '',
    linkedin_url: linkedinUrl,
    company_website: companyWebsite,
    verification_sources,
    reason_for_fit: `${title} at ${company} — matches campaign ICP (${campaign.target_persona || 'decision maker'} in ${campaign.target_industry || 'target industry'}).`,
    buying_signal: buyingSignal,
    lead_type: leadType,
    confidence_score: 'high', // Apollo-sourced emails are verified by default
    enrichment: {
      source: 'apollo',
      apollo_id: person.id,
      seniority: person.seniority,
      departments: person.departments,
      headline: person.headline,
    },
  };
}

function inferPersonaFromTitle(title = '') {
  const t = title.toLowerCase();
  if (/brand/.test(t)) return 'brand_manager';
  if (/digital|e-?commerce|performance|growth/.test(t)) return 'digital_marketer';
  if (/marketing|cmo|head of marketing/.test(t)) return 'marketing_manager';
  if (/founder|ceo|owner|director|md\b/.test(t)) return 'founder';
  return 'unknown';
}

async function apolloFetch(path, apiKey, body) {
  const url = APOLLO_BASE + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `Apollo HTTP ${res.status} on ${path}`);
    err.status = res.status;
    err.payload = data;
    err.path = path;
    throw err;
  }
  return data;
}

function rewriteApolloError(err) {
  const status = err.status;
  const msg = err.message || '';
  const pay = JSON.stringify(err.payload || {}).toLowerCase();

  // Apollo returns 403 with error_code=API_INACCESSIBLE when the API key is not
  // entitled for this endpoint. Two causes we disambiguate:
  //   1. The *workspace* is on a free plan (message: "on a free plan")
  //   2. The *key* was generated before the workspace upgraded — Apollo stamps
  //      plan entitlement onto the key at creation and doesn't retro-upgrade.
  //      Message: "not accessible with this api_key" (no plan mention).
  if (status === 403 && /api_inaccessible|not accessible with this api_key|upgrade your plan|free plan/i.test(pay)) {
    const onFreePlan = /free plan|upgrade your plan/i.test(pay);
    const msg = onFreePlan
      ? 'Your Apollo workspace is on a free plan. Upgrade at https://app.apollo.io/#/settings/plans — Basic tier and above unlock the People Search + Enrichment APIs.'
      : 'Your Apollo key was generated before the workspace upgrade — Apollo stamps plan entitlement onto keys at creation. REVOKE the current key at https://app.apollo.io/#/settings/integrations/api and CREATE A NEW KEY. Paste the new key into Settings → apollo_api_key.';
    const e = new Error(msg);
    e.code = onFreePlan ? 'apollo_plan_insufficient' : 'apollo_key_stale';
    e.billingUrl = onFreePlan ? 'https://app.apollo.io/#/settings/plans' : 'https://app.apollo.io/#/settings/integrations/api';
    return e;
  }
  if (status === 401 || status === 403) {
    const e = new Error('Apollo API key is invalid or lacks permission for this endpoint. Generate a new key at https://app.apollo.io/#/settings/integrations/api and re-save in Settings.');
    e.code = 'apollo_auth_failed';
    return e;
  }
  if (status === 402 || /credit|quota|insufficient/i.test(msg + pay)) {
    const e = new Error('Apollo credit/quota exhausted. Top up at https://app.apollo.io/#/settings/plans or wait for monthly reset.');
    e.code = 'apollo_credits_depleted';
    e.billingUrl = 'https://app.apollo.io/#/settings/plans';
    return e;
  }
  if (status === 429) {
    const e = new Error('Apollo rate limit hit. Wait 60 seconds and try again.');
    e.code = 'apollo_rate_limited';
    return e;
  }
  // 404 or 422 usually means we hit an undocumented endpoint or sent the wrong
  // field names. Bubble the raw Apollo message up so we can debug schema drift.
  if (status === 404 || status === 422) {
    const e = new Error(`Apollo schema mismatch on ${err.path || 'endpoint'}: ${msg}. This is a server bug — check Apollo docs for endpoint/field changes.`);
    e.code = 'apollo_schema_mismatch';
    return e;
  }
  return err;
}

let _campaignLeadsTableEnsured = false;
function ensureCampaignLeadsTable() {
  if (_campaignLeadsTableEnsured) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_leads (
      campaign_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (campaign_id, lead_id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign ON campaign_leads(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_leads_lead ON campaign_leads(lead_id);
  `);
  _campaignLeadsTableEnsured = true;
}
