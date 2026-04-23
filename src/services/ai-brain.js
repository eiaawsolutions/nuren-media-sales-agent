import db from '../db/index.js';
import { getAnthropicClient, getModel, logAICost, checkBudget } from '../utils/anthropic.js';
import { retrieve, formatContext } from './rag.js';

/**
 * Persona-aware, RAG-grounded outbound draft engine.
 *
 * Composes the system prompt from:
 *   1. Nuren identity + positioning moat (settings + brand_inventory)
 *   2. Persona block (from `personas` table)
 *   3. Segment block (from `segments` table, mapped from lead's industry)
 *   4. Tone policy (hard rules: empowering, community-first, never corporate-salesy)
 *   5. RAG chunks (retrieved by lead industry + campaign objective + budget tier)
 *   6. Objection library (for follow-up drafts only)
 *   7. Output schema (strict JSON: subject + body + citations + confidence)
 *
 * Every draft includes `citations` — list of kb chunk IDs it grounded in. If the
 * model cannot find supporting evidence, confidence drops and the draft is
 * flagged for human review instead of auto-sent.
 */
export async function draftOutbound({
  leadId,
  campaignId,
  stepNumber = 1,                      // 1 = intro, 2 = case study, 3 = social proof, 4 = soft close
  variantKey = 'A',
  channel = 'email',                   // email | linkedin_dm | whatsapp
  objectionKey = null,                 // 'no_budget' | 'has_agency' | etc — for objection replies
  userId,
}) {
  if (campaignId) checkBudget(campaignId);

  const lead = db.prepare(`
    SELECT l.*, a.name AS company_name, a.industry AS account_industry, a.sub_industry, a.geography, a.estimated_budget_tier
    FROM leads l LEFT JOIN accounts a ON a.id = l.account_id
    WHERE l.id = ? AND l.user_id = ?
  `).get(leadId, userId);
  if (!lead) throw new Error('lead not found');

  const campaign = campaignId
    ? db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(campaignId, userId)
    : null;

  const personaRow = db.prepare('SELECT * FROM personas WHERE key = ?').get(lead.persona || 'unknown')
    || db.prepare('SELECT * FROM personas WHERE key = ?').get('marketing_manager');
  const segmentRow = db.prepare('SELECT * FROM segments WHERE key = ?').get((lead.account_industry || 'fmcg').toLowerCase())
    || db.prepare('SELECT * FROM segments WHERE key = ?').get('fmcg');
  const objectionRow = objectionKey ? db.prepare('SELECT * FROM objections WHERE key = ?').get(objectionKey) : null;

  const settings = loadSettings();
  const brandInventory = db.prepare('SELECT key, display_name, tagline, strengths, best_fit_industries FROM brand_inventory').all()
    .map(b => ({ ...b, strengths: safeParse(b.strengths, []), best_fit_industries: safeParse(b.best_fit_industries, []) }));

  // RAG retrieval — bias to lead's industry, campaign objective, and budget tier
  const ragQuery = buildRagQuery({ lead, campaign, stepNumber, objectionKey });
  const ragHits = await retrieve(ragQuery, {
    topK: 6,
    target_industry: (lead.account_industry || '').toLowerCase() || null,
    target_objective: campaign?.objective || null,
    budget_tier: campaign?.target_budget_tier && campaign.target_budget_tier !== 'any' ? campaign.target_budget_tier : null,
  });

  // If nothing came back with strict filters, retry without filters (fall back to general relevance)
  const chunks = ragHits.length ? ragHits : await retrieve(ragQuery, { topK: 6 });

  const sys = buildSystemPrompt({ settings, personaRow, segmentRow, objectionRow, brandInventory, lead, campaign, stepNumber, channel });

  const userMsg = buildUserMessage({ lead, campaign, stepNumber, variantKey, channel, objectionKey, chunks });

  const client = getAnthropicClient();
  const model = getModel(objectionKey ? 'objection' : 'default');

  const res = await client.messages.create({
    model,
    max_tokens: 1200,
    system: sys,
    messages: [{ role: 'user', content: userMsg }],
  });
  const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  logAICost({
    userId, campaignId, model,
    taskType: objectionKey ? 'draft_objection' : `draft_${channel}_step${stepNumber}`,
    inputTokens: res.usage?.input_tokens || 0,
    outputTokens: res.usage?.output_tokens || 0,
  });

  const draft = extractJson(text);
  if (!draft) throw new Error('AI returned non-JSON draft. Raw: ' + text.slice(0, 400));

  // Reconcile cited chunk IDs against the hits we actually sent (defense against hallucinated IDs)
  const validIds = new Set(chunks.map(c => c.chunk_id));
  const citedIds = Array.isArray(draft.citations) ? draft.citations.filter(id => validIds.has(id)) : [];
  const citationSources = chunks.filter(c => citedIds.includes(c.chunk_id)).map(c => ({
    chunk_id: c.chunk_id, asset_id: c.asset_id, filename: c.filename, slide_number: c.slide_number, brand: c.brand,
  }));

  const confidence = (draft.confidence || 'medium').toLowerCase();
  const needsReview = confidence === 'low' || citationSources.length === 0;

  return {
    subject: (draft.subject || '').trim(),
    body: (draft.body || '').trim(),
    rationale: (draft.rationale || '').trim(),
    confidence,
    citations: citationSources,
    needs_review: needsReview,
    retrieved_chunk_ids: chunks.map(c => c.chunk_id),
    channel, step_number: stepNumber, variant_key: variantKey,
  };
}

// ------------------------------------------------------------
// Prompt builders
// ------------------------------------------------------------
function buildSystemPrompt({ settings, personaRow, segmentRow, objectionRow, brandInventory, lead, campaign, stepNumber, channel }) {
  const moat = settings.positioning_moat || 'community_trust+kol_network+affiliate_commerce';
  const tone = settings.tone_policy || 'empowering|community_first|maternal_brand_safe|never_corporate_salesy';
  const hybrid = settings.hybrid_mode !== '0';

  const personaPains = safeParse(personaRow.pain_points, []);
  const personaDrivers = safeParse(personaRow.decision_drivers, []);
  const segmentPains = safeParse(segmentRow.pain_points, []);
  const segmentBrands = safeParse(segmentRow.relevant_brands, []);
  const brandList = brandInventory
    .filter(b => segmentBrands.includes(b.key))
    .map(b => `- ${b.display_name} (${b.key}): ${b.tagline || ''} — strengths: ${b.strengths.join(', ')}`)
    .join('\n') || brandInventory.map(b => `- ${b.display_name} (${b.key})`).join('\n');

  const stepGoal = {
    1: 'Day 1 intro + value hook. ONE specific observation about the lead, ONE specific Nuren asset that fits, ONE soft ask (15-min call). NO generic pitches.',
    2: 'Day 3 case study / proof. Reference a specific rate card or campaign asset from the knowledge base that matches their industry + objective. Make the numbers concrete.',
    3: 'Day 6 social proof. Name-drop Nuren brand portfolio (Motherhood, Kelab Mama, Ibuencer) in context. Include one data point from a survey or deck.',
    4: 'Day 10 soft close. Direct ask: propose two specific 15-min slots in the next 3 business days. If no reply, mark for manual review — do NOT push to a fifth step.',
  }[stepNumber] || 'Ongoing follow-up. Short, specific, value-led.';

  const objectionBlock = objectionRow ? `
OBJECTION HANDLER MODE — you are replying to a prospect who raised: "${objectionRow.display_name}".
Strategy: ${objectionRow.response_strategy}
Gold-standard response to anchor to (do NOT copy verbatim — adapt to this lead's specifics):
"""
${objectionRow.example_response}
"""
Preserve the empowering tone. Never argue. Always bridge back to Nuren's moat.
` : '';

  return `You are Nuren Group's inside-sales AI agent. You write outbound for Nuren's media sales team.

## Who Nuren is
${settings.company_name || 'Nuren Group'} — the parenting media + community + commerce network for Malaysia, Singapore, and Thailand (5M+ active parenting audience). We are NOT a media seller — we are a growth partner with a real community, a real KOL network, and a real commerce layer.

## Non-negotiable positioning moat
${moat.split('+').map(m => `- ${m.replace(/_/g, ' ')}`).join('\n')}
Every message MUST anchor on at least one of the three. Never sell "ad inventory" — sell community trust, KOL reach, or commerce conversion.

## Tone policy
${tone.split('|').map(t => `- ${t.replace(/_/g, ' ')}`).join('\n')}
- Use short sentences. Be human. Use first-person ("I'd love to share…", "we've seen…").
- Never use sales clichés ("synergy", "circle back", "touch base", "ROI rockstar", "game-changer").
- Never use emojis unless the lead used one first.

## Hybrid-model rule
${hybrid ? 'The goal of every message is a 15-minute human conversation. Never try to close the deal in email. Human closers take it from the meeting.' : ''}

## Persona brief — ${personaRow.display_name}
${personaRow.description}
Pain points:
${personaPains.map(p => `- ${p}`).join('\n')}
Decision drivers:
${personaDrivers.map(d => `- ${d}`).join('\n')}
Preferred Nuren angle for this persona: ${personaRow.preferred_angle}

## Segment brief — ${segmentRow.display_name}
${segmentRow.description}
Segment pain points:
${segmentPains.map(p => `- ${p}`).join('\n')}
Relevant Nuren brands for this segment:
${brandList}
Preferred angle for this segment: ${segmentRow.preferred_angle}

## Channel
${channelRules(channel)}

## This step
${stepGoal}
${objectionBlock}

## Evidence rule — ZERO HALLUCINATION
You will receive \`RAG SOURCES\` below — chunks from Nuren's actual media kit / rate card / survey decks. You MAY ONLY make concrete claims (numbers, rate cards, package names, reach statistics, case study figures) that are present in those sources. If no source supports a claim you want to make, drop the claim — do not guess.

## Output format — return ONLY this JSON object, no prose, no markdown fences
{
  "subject": "email subject; omit or leave empty for non-email channels",
  "body": "the message body — plain text, not HTML; use short paragraphs separated by blank lines",
  "rationale": "1-2 sentences explaining which persona pain + segment angle + Nuren asset you anchored on",
  "confidence": "high" | "medium" | "low",
  "citations": [chunk_id_integer, ...]    // chunk_ids from RAG sources you grounded in; empty array if general framing only
}
If confidence is "low", the draft will be routed to human review — so only use "low" when evidence is weak.`;
}

function buildUserMessage({ lead, campaign, stepNumber, variantKey, channel, objectionKey, chunks }) {
  const leadBlock = `
LEAD
  name: ${lead.name || '(unknown)'}
  title: ${lead.title || '(unknown)'}
  company: ${lead.company_name || '(unknown)'}
  industry: ${lead.account_industry || '(unknown)'}
  sub_industry: ${lead.sub_industry || ''}
  geography: ${lead.geography || ''}
  persona: ${lead.persona || 'unknown'}
  lead_type: ${lead.lead_type}  confidence: ${lead.confidence_score}
  reason_for_fit: ${lead.reason_for_fit || ''}
  buying_signal: ${lead.buying_signal || ''}
  linkedin: ${lead.linkedin_url || ''}
  website: ${lead.company_website || ''}
`.trim();

  const campaignBlock = campaign ? `
CAMPAIGN
  name: ${campaign.name}
  objective: ${campaign.objective}
  target_budget_tier: ${campaign.target_budget_tier}
  pitch_angle: ${campaign.pitch_angle || '(auto)'}
  notes: ${campaign.notes || ''}
`.trim() : '';

  const ragBlock = chunks.length
    ? `RAG SOURCES (use chunk_id values in your "citations" array):\n\n` +
      chunks.map(c => `chunk_id ${c.chunk_id} | ${c.brand.toUpperCase()} · ${c.asset_type} · slide ${c.slide_number} — ${c.filename}\n${c.content.slice(0, 1800)}`).join('\n\n---\n\n')
    : '(no RAG sources retrieved — write a general-framing intro without specific numbers)';

  return `${leadBlock}

${campaignBlock}

STEP: ${stepNumber} (variant ${variantKey})  CHANNEL: ${channel}${objectionKey ? `  OBJECTION: ${objectionKey}` : ''}

${ragBlock}

Write the message per the system-prompt format. Return JSON only.`;
}

function buildRagQuery({ lead, campaign, stepNumber, objectionKey }) {
  const parts = [];
  if (lead.account_industry) parts.push(lead.account_industry);
  if (lead.sub_industry) parts.push(lead.sub_industry);
  if (campaign?.objective) parts.push(campaign.objective);
  if (campaign?.target_budget_tier && campaign.target_budget_tier !== 'any') parts.push(`${campaign.target_budget_tier} budget`);
  if (stepNumber === 2) parts.push('case study rate card package');
  if (stepNumber === 3) parts.push('audience survey social proof reach');
  if (objectionKey === 'no_budget') parts.push('affiliate performance pilot commission');
  if (objectionKey === 'has_agency') parts.push('community KOL conversion complementary');
  if (objectionKey === 'send_proposal') parts.push('package tier rate card');
  if (lead.persona === 'digital_marketer') parts.push('attribution conversion CPA');
  if (lead.persona === 'brand_manager') parts.push('brand safety community authenticity');
  return parts.filter(Boolean).join(' ') || 'Nuren Motherhood Ibuencer media kit rate card';
}

function channelRules(channel) {
  switch (channel) {
    case 'linkedin_dm':
      return `LinkedIn DM: ≤ 90 words. No salutation like "Hi [name]," — start directly. No signature block. No links.`;
    case 'whatsapp':
      return `WhatsApp: ≤ 60 words. Casual but professional. One paragraph. No signature. No links unless explicitly asked.`;
    case 'email':
    default:
      return `Email: 60–140 words. Friendly opener referencing something specific about the lead (not "I came across your profile"). One value paragraph. One soft CTA. Short signature: "— [name], Nuren Media".`;
  }
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------
function loadSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
