import { getAnthropicClient, getModel, logAICost, checkBudget, getSetting } from '../utils/anthropic.js';
import { verifyLead } from './lead-verification.js';
import { persistLead } from './leads.js';
import db from '../db/index.js';

/**
 * AI lead generation for a campaign.
 *
 * This is Nuren's answer to EIAAW's `generateLeadsTask`. It fires a SINGLE
 * Claude call with the web_search tool; Claude is instructed to find real
 * people on LinkedIn / company pages / news / directories and return JSON.
 *
 * Every returned lead is then run through the same server-side verification
 * gate (`verifyLead`) that CSV upload + webhook paths use — so a model that
 * ignores the prompt and hallucinates cannot sneak low-confidence rows in.
 *
 * Flow:
 *   1. Load campaign + compose ICP string from structured fields
 *      (target_industry + target_persona + pitch_angle + notes).
 *   2. Ask Claude for up to N leads, with web_search enabled.
 *   3. For each lead returned, run verifyLead() — discard on fail.
 *   4. Persist accepted leads via persistLead() (gets accounts rollup for free).
 *   5. Attach every accepted lead to the campaign via campaign_leads junction.
 *   6. Log AI cost + return { generated, rejected, leads }.
 *
 * Hard cap: 15 leads per call. Claude's web_search quality degrades above
 * that — it starts recycling results. If the operator wants more, they click
 * again; each click is an isolated search pass with fresh queries.
 */

const MAX_LEADS_PER_CALL = 15;

export async function generateLeadsForCampaign({ userId, campaignId, count = 5 }) {
  const numLeads = Math.min(Math.max(parseInt(count, 10) || 5, 1), MAX_LEADS_PER_CALL);

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(campaignId, userId);
  if (!campaign) throw new Error('Campaign not found');

  checkBudget(campaignId);

  const icp = buildIcpDescriptor(campaign);
  const existingEmails = db.prepare("SELECT email FROM leads WHERE user_id = ? AND email != ''").all(userId).map(r => r.email.toLowerCase());

  const client = getAnthropicClient();
  // Lead-gen forces Sonnet 4.6 — Haiku 4.5 + web_search + strict JSON output
  // produced empty/malformed responses in prod (2026-04-23). Sonnet handles
  // the 115K-token input envelope + 8 web_searches + JSON schema reliably.
  // Keep the 'enrichment' alias on Haiku for other cheaper tasks.
  const model = getSetting('ai_model_leadgen', 'claude-sonnet-4-6');

  const sys = nurenLeadGenSystemPrompt({ campaign, icp, numLeads, existingEmails });
  const userMessage = `Generate up to ${numLeads} real, verified leads for this campaign. Use web_search. Return ONLY the JSON object.`;

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 8192,
      system: sys,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch (err) {
    throw rewriteAnthropicError(err);
  }

  const textBlocks = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const webSearchUses = (response.content || []).filter(b => b.type === 'server_tool_use' && b.name === 'web_search').length;

  logAICost({
    userId,
    campaignId,
    taskType: 'lead_generation',
    model,
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
    webSearchRequests: webSearchUses,
  });

  const parsed = extractJson(textBlocks);
  const rawLeads = Array.isArray(parsed?.leads) ? parsed.leads : [];

  if (rawLeads.length === 0) {
    console.warn(`[ai-lead-gen] model returned 0 parseable leads. model=${model} output_tokens=${response.usage?.output_tokens} web_searches=${webSearchUses} text_length=${textBlocks.length}`);
    console.warn('[ai-lead-gen] model output (first 2000 chars):', textBlocks.slice(0, 2000));
  }

  const accepted = [];
  const rejected = [];
  const seenInBatch = new Set();

  for (const raw of rawLeads) {
    if (!raw || typeof raw !== 'object') continue;

    // Dedup within THIS batch (model sometimes repeats) + against user's existing emails
    const emailKey = (raw.email || '').toLowerCase().trim();
    if (emailKey) {
      if (seenInBatch.has(emailKey)) { rejected.push({ name: raw.name, reasons: ['duplicate_in_batch'] }); continue; }
      if (existingEmails.includes(emailKey)) { rejected.push({ name: raw.name, reasons: ['duplicate_with_existing'] }); continue; }
      seenInBatch.add(emailKey);
    }

    // Shape into the canonical lead input expected by verifyLead/persistLead.
    // Note: we accept model-returned "lead_type" + "confidence_score" in either case ("Hot"/"hot" etc.) —
    // verifyLead() lowercases these defensively.
    const candidate = {
      name: raw.name,
      type: raw.type || 'B2B',
      title: raw.title || '',
      company: raw.company || '',
      persona: raw.persona || inferPersonaFromTitle(raw.title),
      geography: raw.geography || '',
      industry: raw.industry || campaign.target_industry || 'other',
      sub_industry: raw.sub_industry || '',
      email: raw.email || '',
      phone: raw.phone || '',
      other_contact: raw.other_contact || '',
      linkedin_url: raw.linkedin_url || '',
      company_website: raw.company_website || '',
      verification_sources: raw.verification_sources || [],
      reason_for_fit: raw.reason_for_fit || '',
      buying_signal: raw.buying_signal || '',
      lead_type: (raw.lead_type || 'cold').toString().toLowerCase(),
      confidence_score: (raw.confidence_score || 'medium').toString().toLowerCase(),
      enrichment: raw.enrichment || {},
    };

    const gate = verifyLead(candidate);
    if (!gate.ok) {
      db.prepare("INSERT INTO leads_rejected (user_id, raw_input, reasons, source) VALUES (?,?,?,?)")
        .run(userId, JSON.stringify(raw), JSON.stringify(gate.reasons), 'ai_generated');
      rejected.push({ name: raw.name, reasons: gate.reasons });
      continue;
    }

    const persistResult = persistLead(gate.lead, { userId, source: 'ai_generated' });
    if (!persistResult.ok) {
      rejected.push({ name: raw.name, reasons: persistResult.reasons });
      continue;
    }

    // Attach to campaign. `campaign_leads` is created lazily if absent; see ensureCampaignLeadsTable.
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
    web_search_uses: webSearchUses,
    requested: numLeads,
    leads: accepted,
    rejections: rejected,
  };
}

/**
 * Build a rich ICP descriptor from the campaign's structured targeting fields.
 * Nuren's campaigns are more structured than EIAAW's free-text target_audience,
 * so we compose a prose ICP string from (industry + persona + budget tier +
 * pitch angle + notes). Falls back to generic description if some are missing.
 */
function buildIcpDescriptor(campaign) {
  const bits = [];
  if (campaign.target_persona) bits.push(`Role: ${campaign.target_persona}`);
  if (campaign.target_industry) bits.push(`Industry: ${campaign.target_industry}`);
  if (campaign.target_budget_tier && campaign.target_budget_tier !== 'any') bits.push(`Budget tier: ${campaign.target_budget_tier}`);
  if (campaign.pitch_angle) bits.push(`Pitch angle: ${campaign.pitch_angle}`);
  if (campaign.notes) bits.push(`Notes: ${campaign.notes}`);
  return bits.length ? bits.join(' | ') : 'Brand / Marketing decision-makers at FMCG / maternity / family brands in MY/SG/TH';
}

/**
 * Best-effort persona mapping from a title string. Lets the server set a
 * sensible persona when the model forgets to — still non-lossy because the
 * verification gate doesn't require persona to be set.
 */
function inferPersonaFromTitle(title = '') {
  const t = title.toLowerCase();
  if (/brand/.test(t)) return 'brand_manager';
  if (/digital|e-?commerce|performance|growth/.test(t)) return 'digital_marketer';
  if (/marketing|cmo|head of marketing/.test(t)) return 'marketing_manager';
  if (/founder|ceo|owner|director|md\b/.test(t)) return 'founder';
  return 'unknown';
}

function nurenLeadGenSystemPrompt({ campaign, icp, numLeads, existingEmails }) {
  return `You are Nuren Group's B2B lead generation agent. Nuren sells media sponsorships, KOL campaigns, and affiliate commerce across Motherhood.com.my, Kelabmama, Ibuencer, and the Superapp — a 5M+ mother-and-family audience in Malaysia / Singapore / Thailand.

YOU MUST USE THE web_search TOOL. Do not answer from memory.

## NON-NEGOTIABLE RULES (Nuren Lead Gen Contract)

1. Never fabricate. Every claim needs a source URL you actually visited with web_search.
2. **LinkedIn is mandatory for B2B leads.** A lead without a real, working linkedin_url pointing to a /in/ profile will be DISCARDED server-side. No LinkedIn → do not return the lead.
3. Emails and phone numbers MUST be published on a credible source (company site, verified profile, directory). If not publicly listed, return "" — NEVER guess patterns like first.last@company.com.
4. Every lead needs ≥2 verification_sources URLs. The LinkedIn URL counts as ONE source — you need at least ONE additional source (company team page, news mention, speaker bio, press release, conference listing).
5. Classify confidence as "high" / "medium" / "low". Low-confidence leads will be DISCARDED server-side — don't waste tokens on them.
6. Classify lead_type as "hot" (has a recent buying signal — new campaign, hiring marketing, brand launch, funding, new product line in a Nuren-relevant category) or "cold". Hot leads MUST have a concrete buying_signal string.
7. Return fewer high-quality leads over many weak ones. 3 strong with LinkedIn beats 15 weak without.

## IDEAL CUSTOMER PROFILE (this campaign)

Campaign: "${campaign.name || 'Untitled'}"
Objective: ${campaign.objective || 'consideration'}
ICP: ${icp}

Nuren's general buyer universe (narrow to this campaign's ICP above):
- Marketing Managers / Brand Managers / Digital Marketers / E-commerce Directors / Founders
- Industries: FMCG (baby care, beauty, wellness), Healthcare & Maternity, Education & Family Services, E-commerce DTC
- Geography: Malaysia / Singapore / Thailand primary; global brands with APAC activation also valid
- Intent signals: recent MY/SG/TH campaign, Shopee/Lazada storefront, maternity-adjacent launch, hiring a performance marketer, recent fundraise, new product line in baby/mother/family categories

## WEB SEARCH STRATEGY — LINKEDIN-FIRST (mandatory)

Your budget is ~12 web_search calls. Spend them like this:

### Phase 1 — Surface candidates via LinkedIn search (4–6 queries)
Every discovery query MUST include \`site:linkedin.com/in\` to target real LinkedIn profiles. Bare Google searches return blog posts and press releases — skip those.

Worked query examples (adapt the role/industry/geography to THIS campaign's ICP above):
- \`site:linkedin.com/in "brand manager" (baby OR baby care OR maternity) Malaysia\`
- \`site:linkedin.com/in "head of marketing" FMCG Malaysia -recruiter\`
- \`site:linkedin.com/in "ecommerce manager" (Shopee OR Lazada) Malaysia\`
- \`site:linkedin.com/in "founder" DTC baby Malaysia Singapore\`
- \`site:linkedin.com/in "digital marketing" "maternity" OR "mother" OR "baby" APAC\`
- \`site:linkedin.com/in "growth" "kuala lumpur" OR "singapore" beauty OR wellness\`

Exclude recruiters and MLM: append \`-recruiter -MLM -network marketing\` to any query that returns noise.

### Phase 2 — Secondary verification (2–4 queries per candidate you want to keep)
For each candidate from Phase 1, run ONE targeted query to find a second source:
- \`"<Full Name>" <Company> site:<company-domain>\`  (to confirm they're on the team page)
- \`"<Full Name>" <Company>\`  (to catch news mentions, speaker bios, press releases)

### Phase 3 — Company intent signal (optional, 1–2 queries)
For HOT classification, run a focused query on the company to find a recent buying signal:
- \`"<Company>" (launch OR campaign OR hiring OR fundraise) 2025..2026\`

### Rules
1. Open the most promising results and extract ONLY what you can see on the page. If you cannot open the LinkedIn profile itself (LinkedIn often blocks scraping), the search result preview with role + company + location is acceptable evidence, but you MUST still cite the linkedin.com/in/ URL.
2. Do NOT fall back to scraping generic company directory sites or Crunchbase-style listings — those cannot prove the person is in the role TODAY.
3. Cite every URL you visited in verification_sources. The linkedin.com/in/ URL and the secondary source are BOTH required.
4. If Phase 2 cannot find a secondary source for a candidate → DISCARD that candidate and move on. Don't waste output tokens on unverified leads.

## DEDUPLICATION

Do NOT return any lead whose verified email matches one of these already-known emails for this user (if any): ${existingEmails.slice(0, 30).join(', ') || '(none yet)'}

## OUTPUT SCHEMA (STRICT)

Return ONLY this JSON object (no prose, no markdown fences):

{
  "leads": [
    {
      "name": "Full verified name",
      "type": "B2B" | "B2C" | "B2B2C",
      "title": "Exact job title you saw",
      "company": "Company or brand name",
      "persona": "marketing_manager" | "brand_manager" | "digital_marketer" | "founder" | "unknown",
      "geography": "City, Country (e.g. Kuala Lumpur, Malaysia)",
      "industry": "fmcg" | "healthcare" | "education" | "ecommerce" | "other",
      "sub_industry": "baby | beauty | wellness | maternity | family_services | DTC | ... (short)",
      "email": "verified email or \\"\\"",
      "phone": "publicly listed phone or \\"\\"",
      "other_contact": "other verified channel or \\"\\"",
      "linkedin_url": "https://www.linkedin.com/in/... (MANDATORY — must point to a real /in/ profile; no LinkedIn → discard the lead)",
      "company_website": "https://... (company domain; strongly preferred as the secondary source)",
      "verification_sources": ["https://www.linkedin.com/in/...", "https://second-source..."],
      "reason_for_fit": "1-2 sentences on why this lead matches Nuren's ICP + THIS campaign's pitch",
      "buying_signal": "concrete recent signal (required if lead_type=hot)",
      "lead_type": "hot" | "cold",
      "confidence_score": "high" | "medium" | "low",
      "enrichment": { "notes": "any additional evidence worth preserving" }
    }
  ]
}

Maximum leads in this response: ${numLeads}. Fewer is fine if fewer qualify.`;
}

/**
 * Lazily create the campaign_leads junction table. Nuren's current schema
 * doesn't have it yet — CSV / webhook-path leads live in `sequence_enrollments`
 * when attached to a campaign. AI-generated leads deserve a lighter attachment
 * (not every generated lead gets enrolled into an outreach sequence immediately).
 *
 * Forward-compatible: the table is created if absent; no destructive migration.
 */
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

/**
 * Map raw Anthropic SDK errors (credit depleted, rate limit, auth, overload)
 * into actionable operator messages. Tags the error with a `code` field so the
 * client can surface a specific CTA (e.g., link to billing) instead of showing
 * the raw upstream JSON dump.
 */
function rewriteAnthropicError(err) {
  const msg = err?.message || '';
  const upstream = err?.error?.error?.message || err?.error?.message || '';
  const combined = `${msg} ${upstream}`.toLowerCase();

  if (/credit balance is too low|insufficient.*credit|payment required/.test(combined)) {
    const e = new Error('Anthropic credit balance is depleted. Top up at https://console.anthropic.com/settings/billing, then click AI Generate again. No charge was incurred on this request.');
    e.code = 'anthropic_credits_depleted';
    e.billingUrl = 'https://console.anthropic.com/settings/billing';
    return e;
  }
  if (/invalid api key|authentication|unauthorized/.test(combined)) {
    const e = new Error('Anthropic API key is invalid or was rotated. Update ANTHROPIC_API_KEY on Railway and redeploy.');
    e.code = 'anthropic_auth_failed';
    return e;
  }
  if (/rate.?limit|429/.test(combined)) {
    const e = new Error('Anthropic rate limit hit. Wait ~60 seconds and try again, or reduce lead count per click.');
    e.code = 'anthropic_rate_limited';
    return e;
  }
  if (/overloaded|529|503/.test(combined)) {
    const e = new Error('Anthropic is temporarily overloaded. Wait a minute and try again — no charge on this request.');
    e.code = 'anthropic_overloaded';
    return e;
  }
  return err;
}

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  // Strip markdown fences the model sometimes sneaks in despite instructions
  const fenced = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(fenced); } catch {}
  // Tolerant fallback: find the first balanced {...} object
  const start = fenced.indexOf('{');
  if (start === -1) return null;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < fenced.length; i++) {
    const ch = fenced[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(fenced.slice(start, end + 1)); } catch { return null; }
}
