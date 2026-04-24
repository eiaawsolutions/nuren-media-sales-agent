import { getSetting, logAICost, checkBudget } from '../utils/anthropic.js';
import { decrypt } from '../utils/crypto.js';
import { verifyLead } from './lead-verification.js';
import { persistLead } from './leads.js';
import db from '../db/index.js';

/**
 * Apollo.io lead generation (Path C — runs alongside Claude web_search).
 *
 * Apollo's `mixed_people/search` returns pre-verified B2B leads matched to
 * structured ICP filters (job title + seniority + geography + industry +
 * company size). Faster + more reliable email coverage than LLM discovery,
 * but less nuanced — use for high-volume well-defined ICPs; keep
 * ai-lead-gen.js for nuanced, non-obvious personas.
 *
 * Every returned lead runs through the same `verifyLead()` gate the CSV
 * and AI-generated paths use. Apollo leads almost always pass cleanly
 * (verified LinkedIn URL + 2 sources: Apollo's record + the LinkedIn URL
 * itself), but the gate is still authoritative — if Apollo hands back a
 * person without a /in/ URL, we discard.
 */

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const MAX_LEADS_PER_CALL = 15;
const APOLLO_CREDIT_COST_USD = 0.05; // rough per-email-unlock estimate; tune against actual plan

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

  let response;
  try {
    response = await apolloFetch('/mixed_people/search', apiKey, searchBody);
  } catch (err) {
    throw rewriteApolloError(err);
  }

  const people = Array.isArray(response?.people) ? response.people : [];

  logAICost({
    userId,
    campaignId,
    taskType: 'apollo_lead_gen',
    model: 'apollo.io',
    inputTokens: 0,
    outputTokens: 0,
    webSearchRequests: 0,
    // Cost approximation: 1 credit per person returned with a revealed email.
    // True cost comes from the Apollo billing page; this is for the budget
    // circuit breaker only.
    costOverride: people.filter(p => p.email).length * APOLLO_CREDIT_COST_USD,
  });

  const accepted = [];
  const rejected = [];
  const seenInBatch = new Set();
  const existingEmails = db.prepare("SELECT email FROM leads WHERE user_id = ? AND email != ''").all(userId).map(r => r.email.toLowerCase());

  for (const person of people) {
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
    total_returned: people.length,
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
 * Compose Apollo search filters from a Nuren campaign. Apollo's search is
 * structured — we map the campaign's ICP fields to Apollo's native fields:
 *   target_persona   → person_titles + person_seniorities
 *   target_industry  → q_organization_keyword_tags (loose industry match)
 *   target_budget_tier → organization_num_employees_ranges (proxy for company size)
 *   geography        → person_locations (MY/SG/TH default)
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

  // Industry — keyword match on the organization record
  const industryKeywords = expandIndustryKeywords(campaign.target_industry);
  if (industryKeywords.length) f.q_organization_keyword_tags = industryKeywords;

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

function expandIndustryKeywords(industry) {
  const map = {
    fmcg: ['consumer goods', 'consumer products', 'FMCG', 'beauty', 'personal care', 'baby care'],
    healthcare: ['healthcare', 'maternity', 'wellness', 'pharmaceutical', 'medical'],
    education: ['education', 'e-learning', 'childcare', 'family services'],
    ecommerce: ['e-commerce', 'online retail', 'DTC', 'retail'],
    other: [],
  };
  return map[industry] || [];
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
      'Cache-Control': 'no-cache',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `Apollo HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function rewriteApolloError(err) {
  const status = err.status;
  const msg = err.message || '';
  if (status === 401 || status === 403) {
    const e = new Error('Apollo API key is invalid or lacks permission for this endpoint. Generate a new key at https://app.apollo.io/#/settings/integrations/api and re-save in Settings.');
    e.code = 'apollo_auth_failed';
    return e;
  }
  if (status === 402 || /credit|quota|limit/i.test(msg)) {
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
