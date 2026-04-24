import { getAnthropicClient, getSetting, logAICost, checkBudget } from '../utils/anthropic.js';
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

  // Pre-load the user's known Apollo IDs so we never enrich the same person
  // twice. This runs BEFORE search so we can fetch extra pages if the first
  // page is mostly duplicates — saving Apollo credits for genuinely new leads.
  const knownApolloIds = new Set(
    db.prepare("SELECT enrichment FROM leads WHERE user_id = ? AND source = 'apollo' AND enrichment IS NOT NULL").all(userId)
      .map(r => { try { return JSON.parse(r.enrichment)?.apollo_id; } catch { return null; } })
      .filter(Boolean)
  );
  console.log(`[apollo-lead-gen] START campaignId=${campaignId} requested=${numLeads} known_apollo_ids=${knownApolloIds.size} filters=${JSON.stringify(filters)}`);

  // Step 1 — zero-credit structured search. We over-fetch + paginate to
  // compensate for dedup against knownApolloIds, so a user who has already
  // enrolled 5 leads can still get 5 genuinely new ones on the next click.
  // Apollo's per_page max is 25 for api_search on Professional; we use 15
  // as a safe default and iterate pages until we have enough candidates.
  const candidates = [];
  let searchPages = 0;
  const MAX_SEARCH_PAGES = 5;
  const PER_PAGE = 15;

  try {
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const searchBody = { ...filters, page, per_page: PER_PAGE };
      const resp = await apolloFetch('/mixed_people/api_search', apiKey, searchBody);
      searchPages++;
      const pagePeople = Array.isArray(resp?.people) ? resp.people : [];
      const fresh = pagePeople.filter(p => !knownApolloIds.has(p.id));
      candidates.push(...fresh);
      console.log(`[apollo-lead-gen] search page ${page}: ${pagePeople.length} returned, ${fresh.length} new (total so far: ${candidates.length}/${numLeads})`);
      if (candidates.length >= numLeads) break;
      // Stop if Apollo had no more results on this page
      if (pagePeople.length < PER_PAGE) break;
    }
  } catch (err) {
    throw rewriteApolloError(err);
  }

  // Trim to what the operator asked for — no point enriching candidates they
  // won't see in this batch. They'll surface on the next click.
  if (candidates.length > numLeads) candidates.length = numLeads;

  if (candidates.length === 0) {
    return {
      generated: 0, rejected: 0, rejected_cold: 0,
      source: 'apollo', requested: numLeads, total_returned: 0,
      search_pages: searchPages, enrichment_calls: 0, credits_consumed: 0,
      leads: [], rejections: [],
      message: knownApolloIds.size > 0
        ? `All ${searchPages * PER_PAGE} search results were already in your leads. Broaden the campaign ICP (industry, persona, budget tier) to find new candidates.`
        : 'No candidates matched the campaign ICP. Try broadening the targeting.',
    };
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
  let rejectedIcp = 0;
  const seenInBatch = new Set();
  const existingEmails = db.prepare("SELECT email FROM leads WHERE user_id = ? AND email != ''").all(userId).map(r => r.email.toLowerCase());

  // Pass 1 — local vetting: dedup + hotness. Collect candidates that survive
  // for the batch LLM ICP check that runs next. We don't persist anything yet
  // because we want the LLM to see the whole batch at once (single Haiku call,
  // cheaper + more consistent than per-lead calls).
  const survivors = []; // { person, candidate, hotVerdict }
  for (const person of enrichedPeople) {
    const candidate = apolloPersonToLead(person, campaign);

    const emailKey = (candidate.email || '').toLowerCase().trim();
    if (emailKey) {
      if (seenInBatch.has(emailKey)) { rejected.push({ name: candidate.name, reasons: ['duplicate_in_batch'] }); continue; }
      if (existingEmails.includes(emailKey)) { rejected.push({ name: candidate.name, reasons: ['duplicate_with_existing'] }); continue; }
      seenInBatch.add(emailKey);
    }

    const hotVerdict = classifyHotness(person);
    if (!hotVerdict.hot) {
      rejectedCold++;
      db.prepare("INSERT INTO leads_rejected (user_id, raw_input, reasons, source) VALUES (?,?,?,?)")
        .run(userId, JSON.stringify(person), JSON.stringify(['cold:' + hotVerdict.reason]), 'apollo');
      rejected.push({ name: candidate.name, reasons: ['cold:' + hotVerdict.reason] });
      continue;
    }
    candidate.lead_type = 'hot';
    candidate.buying_signal = hotVerdict.signal;
    if (candidate.enrichment && typeof candidate.enrichment === 'object') {
      candidate.enrichment.outreach_mode = hotVerdict.outreach_mode;
    }
    survivors.push({ person, candidate, hotVerdict });
  }

  // Pass 2 — LLM ICP post-vet. One Haiku call classifies all survivors as
  // fit / weak / reject against Nuren's specific buyer profile (mother/baby/
  // family brands that run paid media in MY/SG/TH). This filters out the
  // wrong-vertical noise that Apollo's keyword-tag filter still lets through
  // (edge cases: B2B agencies that serve consumer brands, corporate HQs of
  // consumer groups that don't run paid media, wrong-geography matches).
  const icpVerdicts = survivors.length > 0
    ? await llmPostVetIcp(survivors, campaign)
    : new Map();

  // Pass 3 — persist survivors that passed both gates.
  for (const { person, candidate, hotVerdict } of survivors) {
    const icpVerdict = icpVerdicts.get(person.id) || { fit: 'weak', reason: 'no verdict returned' };
    if (icpVerdict.fit === 'reject') {
      rejectedIcp++;
      db.prepare("INSERT INTO leads_rejected (user_id, raw_input, reasons, source) VALUES (?,?,?,?)")
        .run(userId, JSON.stringify(person), JSON.stringify(['icp_reject:' + icpVerdict.reason]), 'apollo');
      rejected.push({ name: candidate.name, reasons: ['icp_reject:' + icpVerdict.reason] });
      continue;
    }
    // Record the ICP verdict on the lead so the UI can render a "fit" or
    // "weak fit" chip next to the HOT badge.
    if (candidate.enrichment && typeof candidate.enrichment === 'object') {
      candidate.enrichment.icp_fit = icpVerdict.fit;
      candidate.enrichment.icp_reason = icpVerdict.reason;
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
      buying_signal: gate.lead.buying_signal,
      outreach_mode: hotVerdict.outreach_mode,
      icp_fit: icpVerdict.fit,
      icp_reason: icpVerdict.reason,
    });
  }

  const emailReady = accepted.filter(l => l.outreach_mode === 'email').length;
  const linkedinOnly = accepted.filter(l => l.outreach_mode === 'linkedin').length;
  const strongFit = accepted.filter(l => l.icp_fit === 'fit').length;
  const weakFit = accepted.filter(l => l.icp_fit === 'weak').length;
  console.log(`[apollo-lead-gen] DONE persisted=${accepted.length} (${strongFit} fit + ${weakFit} weak | ${emailReady} email-ready + ${linkedinOnly} LinkedIn-only) rejected_total=${rejected.length} rejected_cold=${rejectedCold} rejected_icp=${rejectedIcp} credits=${creditsConsumed}`);

  return {
    generated: accepted.length,
    email_ready: emailReady,
    linkedin_only: linkedinOnly,
    strong_fit: strongFit,
    weak_fit: weakFit,
    rejected: rejected.length,
    rejected_cold: rejectedCold,
    rejected_icp: rejectedIcp,
    source: 'apollo',
    requested: numLeads,
    total_returned: candidates.length,
    search_pages: searchPages,
    enrichment_calls: enrichmentCalls,
    credits_consumed: creditsConsumed,
    leads: accepted,
    rejections: rejected,
  };
}

/**
 * Batch ICP post-vet — one Haiku call classifies every hot-passing candidate
 * against Nuren's real buyer profile (mother/baby/family brands running paid
 * media in MY/SG/TH). Returns a Map of apollo_id → { fit, reason }.
 *
 * fit = "fit"    — consumer brand that would genuinely buy Nuren media placements
 * fit = "weak"   — adjacent/possible fit; persisted but tagged for operator review
 * fit = "reject" — wrong vertical (e.g. state fund, real estate, B2B SaaS, blockchain)
 *
 * Defensive: if the LLM call fails (credits depleted, rate limit, parse error),
 * every survivor gets fit=weak so nothing is silently dropped. Pre-filter keyword
 * tags already did most of the work; LLM is precision polish.
 */
async function llmPostVetIcp(survivors, campaign) {
  const verdicts = new Map();
  try {
    const client = getAnthropicClient();
    const model = getSetting('ai_model_chat', 'claude-haiku-4-5-20251001');

    const candidatesBlock = survivors.map((s, i) => {
      const p = s.person;
      const orgName = p.organization?.name || '';
      const industry = p.organization?.industry || '';
      const seoDesc = p.organization?.short_description || p.organization?.seo_description || '';
      const empCount = p.organization?.estimated_num_employees;
      return `[${i + 1}] apollo_id=${p.id}
name: ${p.name}
title: ${p.title}
headline: ${(p.headline || '').slice(0, 160)}
company: ${orgName} (${industry || 'industry unknown'}, ~${empCount || '?'} employees)
company_description: ${(seoDesc || '').slice(0, 300)}`;
    }).join('\n\n');

    const campaignCtx = [
      `name: ${campaign.name || 'Untitled'}`,
      `target_industry: ${campaign.target_industry || 'any'}`,
      `target_persona: ${campaign.target_persona || 'any'}`,
      `pitch_angle: ${campaign.pitch_angle || 'auto'}`,
      campaign.notes ? `notes: ${campaign.notes}` : null,
    ].filter(Boolean).join(' | ');

    const systemPrompt = `You are a B2B lead qualifier for Nuren Media Group — Malaysia/Singapore/Thailand's largest family-media network (Motherhood.com.my, Kelabmama, Ibuencer, Nuren Superapp). Nuren sells media sponsorships, KOL campaigns, and affiliate commerce to brands that target MOTHERS, BABIES, PREGNANT WOMEN, and FAMILIES.

Your job: given a batch of candidate leads, classify each as "fit" / "weak" / "reject" against Nuren's real ICP.

FIT (strong match):
- Consumer brands in baby care, maternity, beauty, personal care, FMCG, healthcare, family services, baby/child education, DTC e-commerce
- Media agencies that buy paid media for consumer brands (IPG, Publicis, Omnicom, Dentsu, local Malaysian agencies)
- E-commerce platforms where mothers shop (Lazada, Shopee, Watsons, Guardian)
- Influencer/creator marketplaces relevant to parenting audiences

WEAK (adjacent, operator judgment):
- Alcohol, tobacco, adult brands that sometimes run family-friendly campaigns
- Corporate-level brand teams at conglomerates that own a family-relevant sub-brand
- Generic FMCG where the person's role doesn't touch consumer-facing campaigns

REJECT (wrong vertical):
- State investment funds, real estate, commercial property
- B2B SaaS / enterprise tech / blockchain / crypto
- Industrial, engineering, construction, manufacturing (unless the person clearly owns a family-product sub-brand)
- Training / HR / recruiting / consulting firms
- Pure B2B services with no consumer brand exposure
- Wrong geography (e.g. India, Vietnam, EU) — we only sell in MY/SG/TH

Be strict on REJECT — operators hate getting wrong-vertical leads in their campaigns. Be generous on WEAK if it's plausibly adjacent.

Output ONLY JSON in this exact shape, no prose:
{ "verdicts": [{ "apollo_id": "...", "fit": "fit" | "weak" | "reject", "reason": "one-sentence justification" }] }`;

    const userMsg = `CAMPAIGN: ${campaignCtx}

CANDIDATES:
${candidatesBlock}

Classify each candidate. Return JSON only.`;

    const response = await client.messages.create({
      model,
      max_tokens: Math.min(300 + survivors.length * 60, 3000),
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });

    logAICost({
      userId: null, // post-vet is a service cost, not a per-user cost; user already billed via credits_consumed
      campaignId: campaign.id,
      taskType: 'apollo_icp_postvet',
      model,
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    });

    const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    // Tolerate markdown fences the model sometimes adds despite instructions
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed?.verdicts)) {
      for (const v of parsed.verdicts) {
        if (!v?.apollo_id) continue;
        const fit = ['fit', 'weak', 'reject'].includes(v.fit) ? v.fit : 'weak';
        verdicts.set(v.apollo_id, { fit, reason: (v.reason || '').slice(0, 200) });
      }
    }
    console.log(`[apollo-lead-gen] ICP post-vet: ${verdicts.size}/${survivors.length} verdicts returned`);
  } catch (err) {
    console.warn(`[apollo-lead-gen] ICP post-vet failed (falling back to weak for all): ${err.message}`);
    // Fallback: tag every survivor as weak so the operator sees them and can judge manually.
    for (const s of survivors) verdicts.set(s.person.id, { fit: 'weak', reason: 'ICP post-vet unavailable' });
  }
  return verdicts;
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
  // Seniority gate — must be a decision-maker. Junior ICs aren't worth the
  // outreach; they can't sign contracts.
  const seniority = (person.seniority || '').toLowerCase();
  if (seniority && !HOT_SENIORITIES.has(seniority)) {
    return { hot: false, reason: `seniority_too_junior:${seniority}` };
  }

  // Email verification is NO LONGER a hard gate. 2026-04-24 operator feedback:
  // Apollo frequently returns real decision-makers at real companies with
  // `email_status: unavailable` — e.g. Brand Leads at Lazada, Cetaphil,
  // Unicharm — where we could never build outreach if we rejected these.
  // Instead: keep them as HOT, mark email as '' (not guessed), and let the
  // operator reach them via LinkedIn DM. A separate outreach_mode tag tells
  // the UI whether the lead can be enrolled into email sequences.
  //
  // Apollo's email_status values: 'verified', 'likely_to_engage', 'guessed',
  // 'unavailable', null. Only 'verified' is safe for cold-outreach automation.

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

  // outreach_mode tells the UI + the sequence scheduler whether this lead
  // can be reached via email automation. 'email' = verified, ready for cold
  // sequence. 'linkedin' = real decision-maker but no verified email, needs
  // manual LinkedIn DM / calling / alternative channel.
  const emailStatus = (person.email_status || '').toLowerCase();
  const outreachMode = emailStatus === 'verified' ? 'email' : 'linkedin';

  return { hot: true, signal: best, reason: null, outreach_mode: outreachMode };
}

function getApolloKey() {
  const raw = getSetting('apollo_api_key', '');
  if (!raw) return null;
  return decrypt(raw);
}

/**
 * Compose Apollo search filters from a Nuren campaign.
 *
 *   target_persona     → person_titles + person_seniorities (documented)
 *   target_budget_tier → organization_num_employees_ranges (documented)
 *   target_industry    → q_organization_keyword_tags (undocumented but works
 *                        on Professional+; Apollo matches these keyword tags
 *                        against the organization's indexed text, dramatically
 *                        narrowing to on-industry companies). Verified live
 *                        2026-04-24: with baby/maternity/FMCG keyword tags,
 *                        a MY Brand Manager search dropped from 4,528 → 379
 *                        total entries, surfacing real consumer brands like
 *                        Mama's Choice, The MILK Inc, Lam Soon instead of PNB,
 *                        CBRE, blockchain startups.
 *   geography          → person_locations (documented, MY/SG/TH default)
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

  // Industry keyword tags — the biggest precision lever. Expands the campaign's
  // target_industry into Apollo-friendly keyword tags that the org record must
  // mention somewhere in its indexed profile. Mothers/baby/family brands are
  // Nuren's entire buyer universe, so every search applies a baseline family-
  // adjacent tag set unless the campaign is explicitly targeting another vertical.
  const keywordTags = expandIndustryToKeywordTags(campaign.target_industry);
  if (keywordTags.length) f.q_organization_keyword_tags = keywordTags;

  // Geography — Nuren's primary universe is MY/SG/TH; allow override via notes field
  f.person_locations = ['Malaysia', 'Singapore', 'Thailand'];

  // Company size — coarse mapping from budget tier to employee range
  const sizeRanges = mapBudgetTierToEmployeeRanges(campaign.target_budget_tier);
  if (sizeRanges.length) f.organization_num_employees_ranges = sizeRanges;

  return f;
}

/**
 * Map a campaign's target_industry to the keyword tags Apollo indexes against
 * the organization record. The baseline tag set ensures even `other` or null
 * industries get narrowed to Nuren's mother/baby/family universe, which is
 * what the entire app exists to sell into.
 */
function expandIndustryToKeywordTags(industry) {
  const BASELINE_FAMILY_TAGS = ['baby', 'maternity', 'mother', 'family', 'FMCG', 'consumer goods', 'personal care'];
  const map = {
    fmcg: ['FMCG', 'consumer goods', 'consumer packaged goods', 'baby', 'maternity', 'beauty', 'personal care', 'baby care', 'skincare'],
    healthcare: ['healthcare', 'maternity', 'wellness', 'pharmaceutical', 'hospital', 'clinic', 'medical', 'baby'],
    education: ['education', 'childcare', 'early childhood', 'preschool', 'family services', 'parenting', 'tuition'],
    ecommerce: ['e-commerce', 'online retail', 'DTC', 'direct-to-consumer', 'marketplace', 'beauty', 'baby'],
    other: BASELINE_FAMILY_TAGS,
  };
  return map[(industry || 'other').toLowerCase()] || BASELINE_FAMILY_TAGS;
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
