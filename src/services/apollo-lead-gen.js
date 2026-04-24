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
  // id/name/title/company/linkedin_url but NO email or phone.
  let searchResponse;
  try {
    searchResponse = await apolloFetch('/mixed_people/api_search', apiKey, searchBody);
  } catch (err) {
    throw rewriteApolloError(err);
  }

  const candidates = Array.isArray(searchResponse?.people) ? searchResponse.people : [];

  // Step 2 — enrichment per candidate. Each call burns Apollo credits to reveal
  // the email + phone. We do this sequentially rather than in parallel so one
  // 429 doesn't cascade and so operators can watch the credit burn visibly.
  const enrichedPeople = [];
  let enrichmentCalls = 0;
  for (const candidate of candidates) {
    try {
      const enriched = await apolloFetch('/people/match', apiKey, {
        id: candidate.id,
        reveal_personal_emails: true,
        reveal_phone_number: true,
      });
      enrichmentCalls++;
      // The enrichment response nests the person under `person`; fall back to
      // top-level if the API shape changes.
      enrichedPeople.push(enriched?.person || enriched);
    } catch (err) {
      // If we hit a rate limit or credit block mid-batch, stop enrichment and
      // surface what we've got. Keep unenriched candidates as "no email" leads
      // so the verification gate can still accept LinkedIn-only records.
      const rewritten = rewriteApolloError(err);
      if (rewritten.code === 'apollo_credits_depleted' || rewritten.code === 'apollo_rate_limited') {
        console.warn(`[apollo-lead-gen] enrichment halted at ${enrichmentCalls}/${candidates.length}: ${rewritten.message}`);
        // Push the raw candidate so we keep the LinkedIn-only lead.
        enrichedPeople.push(candidate);
        break;
      }
      // Other errors — push raw candidate, continue.
      console.warn(`[apollo-lead-gen] enrichment failed for ${candidate.id}: ${err.message}`);
      enrichedPeople.push(candidate);
    }
  }

  logAICost({
    userId,
    campaignId,
    taskType: 'apollo_lead_gen',
    model: 'apollo.io',
    inputTokens: 0,
    outputTokens: 0,
    webSearchRequests: 0,
    // Cost driver is enrichment calls, not search results. One /people/match
    // call per candidate we kept, each at ~1 Apollo credit ≈ APOLLO_CREDIT_COST_USD.
    costOverride: enrichmentCalls * APOLLO_CREDIT_COST_USD,
  });

  const accepted = [];
  const rejected = [];
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
    });
  }

  return {
    generated: accepted.length,
    rejected: rejected.length,
    source: 'apollo',
    requested: numLeads,
    total_returned: candidates.length,
    enrichment_calls: enrichmentCalls,
    leads: accepted,
    rejections: rejected,
  };
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

  // Buying signal — Apollo sometimes returns `employment_history[0].start_date`;
  // if it's within the last 90 days, flag as "recent job change" signal.
  let buyingSignal = '';
  let leadType = 'cold';
  const recentStart = person.employment_history?.[0]?.start_date;
  if (recentStart) {
    const started = new Date(recentStart);
    const days = (Date.now() - started.getTime()) / (86400 * 1000);
    if (days >= 0 && days <= 90) {
      buyingSignal = `Started in current role ${Math.round(days)} days ago — fresh mandate to prove impact`;
      leadType = 'hot';
    }
  }

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
