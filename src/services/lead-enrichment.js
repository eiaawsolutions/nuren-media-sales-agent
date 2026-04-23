import { getAnthropicClient, getModel, logAICost, checkBudget } from '../utils/anthropic.js';
import { verifyLead } from './lead-verification.js';

/**
 * AI enrichment for a raw CSV row. Uses Anthropic's web_search tool so the
 * model MUST find real, citable evidence. We then run verifyLead() on the
 * returned object — the prompt alone is never trusted.
 *
 * Input: { name, company, email?, linkedin_url?, company_website?, hint? }
 *        (hint = optional free text from salesperson about why the lead matters)
 * Output:
 *   { ok: true,  lead: <validated enriched lead> }
 *   { ok: false, reasons: [...], lead: <partially enriched>, raw: <model output> }
 */
export async function enrichLead(input, { userId, campaignId } = {}) {
  const client = getAnthropicClient();
  const model = getModel('enrichment');
  if (campaignId) checkBudget(campaignId);

  const sys = `You are a B2B lead research agent for Nuren Group — a Malaysian parenting media + community + commerce network selling media sponsorships, KOL campaigns, and affiliate commerce to brand/marketing decision-makers.

YOU MUST USE THE web_search TOOL. Do not answer from memory.

NON-NEGOTIABLE RULES (Nuren Lead Gen Contract — failures cause the lead to be discarded server-side):
1. Never fabricate. Every claim needs a source URL you visited.
2. Emails and phone numbers MUST be published on a credible source (company site, verified profile, directory). If not found publicly, return "" — NEVER guess (no first.last@company.com patterns).
3. Every lead needs ≥1 verification_sources URL (LinkedIn, official site, news, directory, verified social).
4. Classify confidence as high / medium / low. Low confidence -> will be discarded.
5. Classify lead_type as 'hot' (has a buying signal — recent campaign, hiring marketing, brand launch, funding, new product line in a Nuren-relevant category) or 'cold'.
6. Return ONE JSON object matching the schema — no prose, no markdown.

Nuren's ideal buyers:
- Marketing Managers / Brand Managers / Digital Marketers / Founders at brands in FMCG (baby/beauty/wellness), Healthcare & Maternity, Education & Family Services, E-commerce DTC
- Active in MY / SG / TH / APAC preferred, but do not reject global brands targeting APAC mothers
- Signs of intent: recent Malaysian campaign, Shopee/Lazada presence, maternity-adjacent product launch, hiring a performance marketer, recent fundraise

Return JSON exactly like:
{
  "name": "...",
  "title": "...",
  "company": "...",
  "persona": "marketing_manager" | "brand_manager" | "digital_marketer" | "founder" | "unknown",
  "type": "B2B" | "B2C" | "B2B2C",
  "geography": "MY" | "SG" | "TH" | "APAC" | "Global" | "...",
  "industry": "fmcg" | "healthcare" | "education" | "ecommerce" | "other",
  "sub_industry": "baby | beauty | wellness | maternity | family_services | DTC | ...",
  "email": "",                       // only if publicly verified, else ""
  "phone": "",                       // only if publicly listed, else ""
  "other_contact": "",
  "linkedin_url": "https://...",
  "company_website": "https://...",
  "verification_sources": ["https://...", "https://..."],
  "reason_for_fit": "1-2 sentences on why this lead matches Nuren's ICP",
  "buying_signal": "explicit recent signal if lead_type=hot, else \\"\\"",
  "lead_type": "hot" | "cold",
  "confidence_score": "high" | "medium" | "low",
  "enrichment": { "notes": "any additional evidence worth preserving" }
}
Return ONLY the JSON object.`;

  const userMessage = `Research this lead with web_search and return the JSON.

Name: ${input.name || '(unknown)'}
Company: ${input.company || '(unknown)'}
${input.email ? 'Email hint: ' + input.email : ''}
${input.linkedin_url ? 'LinkedIn: ' + input.linkedin_url : ''}
${input.company_website ? 'Website: ' + input.company_website : ''}
${input.hint ? 'Salesperson note: ' + input.hint : ''}`;

  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system: sys,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    messages: [{ role: 'user', content: userMessage }],
  });

  // Aggregate text from all text blocks (web_search returns interleaved tool_use + text)
  const textBlocks = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const webSearchUses = (response.content || []).filter(b => b.type === 'server_tool_use' && b.name === 'web_search').length;

  logAICost({
    userId,
    campaignId,
    taskType: 'lead_enrichment',
    model,
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
    webSearchRequests: webSearchUses,
  });

  const json = extractJson(textBlocks);
  if (!json) {
    return { ok: false, reasons: ['model_returned_non_json'], lead: null, raw: textBlocks };
  }

  const result = verifyLead(json);
  return { ...result, raw: textBlocks, webSearchUses };
}

function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
