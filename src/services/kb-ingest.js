import fs from 'fs';
import path from 'path';
import db from '../db/index.js';
import { parsePptx } from './pptx-parser.js';
import { tagFromFilename } from './kb-tagger.js';
import { getAnthropicClient, getModel, logAICost, embed } from '../utils/anthropic.js';

const MAX_IMAGES_PER_SLIDE = 3;      // cap vision tokens per slide
// Claude Vision's 5 MB limit is on the *base64-encoded* payload, which is 4/3
// of the raw buffer size. 3.7 MB raw → ~4.93 MB base64, safely under the cap.
const MAX_IMAGE_BYTES = 3_700_000;
const MAX_CHUNK_CHARS = 2400;        // ~600 tokens per chunk; balances retrieval precision vs coverage

/**
 * Ingest one PPTX file end-to-end:
 *   1. Parse (text + images)
 *   2. Filename-based brand/asset_type tagging (deterministic, no LLM)
 *   3. Vision pass on image-bearing slides (rate-card tables, charts, layouts)
 *      — returns structured rate extraction for rate-card slides
 *   4. Chunk merged text + vision summary; tag + embed + index
 *
 * ZERO-HALLUCINATION CONTRACT: Rate-card slides get a *structured* vision call
 * with a strict JSON schema. If the model is uncertain about a number it must
 * emit null and add it to `uncertainties`. We store structured rates in
 * kb_slides.vision_rates_json and ALSO echo them verbatim into the chunk
 * content, so retrieval always surfaces real extracted numbers.
 */
export async function ingestPptx(filePath, { userId = null, force = false } = {}) {
  const filename = path.basename(filePath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || !filename.toLowerCase().endsWith('.pptx')) {
    throw new Error(`Not a PPTX file: ${filename}`);
  }

  console.log(`\n[ingest] ${filename} (${(stat.size / 1_000_000).toFixed(1)} MB)`);
  const parsed = await parsePptx(filePath);
  console.log(`[ingest]   parsed: ${parsed.slide_count} slides, ${parsed.slides.reduce((n, s) => n + s.images.length, 0)} images, sha ${parsed.sha256.slice(0, 12)}`);

  // Dedupe by filename OR sha256 unless force
  const existing = db.prepare('SELECT id, sha256, ingest_status FROM kb_assets WHERE filename = ? OR sha256 = ?').get(filename, parsed.sha256);
  let assetId;
  let resumeFromEmbed = false;
  if (existing) {
    if (!force && existing.ingest_status === 'completed' && existing.sha256 === parsed.sha256) {
      console.log(`[ingest]   already ingested (id ${existing.id}) — skipping (pass force=true to reingest).`);
      return { assetId: existing.id, skipped: true };
    }
    // RESUME-SAFE: if slides already exist and sha matches and this isn't a forced re-vision,
    // keep the expensive Vision output and jump straight to (re-)embedding.
    const existingSlideCount = db.prepare('SELECT COUNT(*) AS c FROM kb_slides WHERE asset_id = ?').get(existing.id).c;
    if (!force && existingSlideCount > 0 && existing.sha256 === parsed.sha256) {
      console.log(`[ingest]   found ${existingSlideCount} existing slides — resuming at embedding step (Vision skipped, $0 extra vision cost).`);
      db.prepare('DELETE FROM kb_chunks WHERE asset_id = ?').run(existing.id);
      db.prepare("UPDATE kb_assets SET ingest_status = 'embedding', ingest_error = NULL, embedding_cost_usd = 0 WHERE id = ?").run(existing.id);
      assetId = existing.id;
      resumeFromEmbed = true;
    } else {
      // force=true OR sha changed OR no slides yet -> full re-ingest: wipe slides + chunks
      db.prepare('DELETE FROM kb_slides WHERE asset_id = ?').run(existing.id);
      db.prepare('DELETE FROM kb_chunks WHERE asset_id = ?').run(existing.id);
      db.prepare("UPDATE kb_assets SET sha256 = ?, slide_count = ?, ingest_status = 'parsing', ingest_error = NULL, vision_cost_usd = 0, embedding_cost_usd = 0 WHERE id = ?")
        .run(parsed.sha256, parsed.slide_count, existing.id);
      assetId = existing.id;
    }
  } else {
    const tags = tagFromFilename(filename);
    const result = db.prepare(
      "INSERT INTO kb_assets (filename, title, brand, asset_type, target_industry, target_objective, budget_tier, sha256, slide_count, ingest_status) VALUES (?,?,?,?,?,?,?,?,?, 'parsing')"
    ).run(filename, parsed.title, tags.brand, tags.asset_type, tags.target_industry, tags.target_objective, tags.budget_tier, parsed.sha256, parsed.slide_count);
    assetId = result.lastInsertRowid;
  }

  const asset = db.prepare('SELECT * FROM kb_assets WHERE id = ?').get(assetId);
  console.log(`[ingest]   tags: brand=${asset.brand} type=${asset.asset_type} objective=${asset.target_objective}`);

  // Vision pass — skipped entirely on resume
  let visionCostTotal = 0;
  if (!resumeFromEmbed) {
  db.prepare("UPDATE kb_assets SET ingest_status = 'vision' WHERE id = ?").run(assetId);

  const insertSlide = db.prepare(
    'INSERT INTO kb_slides (asset_id, slide_number, raw_text, speaker_notes, vision_summary, vision_rates_json, image_count) VALUES (?,?,?,?,?,?,?)'
  );

  let anyImages = false;
  for (const slide of parsed.slides) {
    const hasText = slide.rawText && slide.rawText.trim().length > 20;
    const hasImages = slide.images.length > 0;
    if (hasImages) anyImages = true;

    let visionSummary = null;
    let ratesJson = null;

    if (hasImages) {
      const isRateCard = asset.asset_type === 'rate_card';
      try {
        const { summary, rates, cost } = await visionPass({
          userId,
          slideNumber: slide.number,
          rawText: slide.rawText,
          images: slide.images.slice(0, MAX_IMAGES_PER_SLIDE),
          assetTitle: asset.title,
          assetType: asset.asset_type,
          brand: asset.brand,
          rateCardMode: isRateCard,
        });
        visionSummary = summary;
        ratesJson = rates ? JSON.stringify(rates) : null;
        visionCostTotal += cost;
      } catch (err) {
        console.warn(`[ingest]   slide ${slide.number} vision failed: ${err.message}`);
      }
    }

    insertSlide.run(
      assetId,
      slide.number,
      slide.rawText || '',
      slide.speakerNotes || '',
      visionSummary,
      ratesJson,
      slide.images.length
    );
    if (hasImages) process.stdout.write(`  slide ${slide.number}✓`);

    // Release image buffers so V8 can GC them before processing the next slide.
    // Critical for large decks (100+ MB) with hundreds of images — without this,
    // the container OOMs on Node's default 512 MB heap.
    for (const img of slide.images) img.buffer = null;
    slide.images.length = 0;
  }
  if (anyImages) process.stdout.write('\n');

  db.prepare('UPDATE kb_assets SET vision_cost_usd = ? WHERE id = ?').run(visionCostTotal, assetId);
  db.prepare("UPDATE kb_assets SET ingest_status = 'embedding' WHERE id = ?").run(assetId);
  } // end !resumeFromEmbed block

  // --- Chunk + embed ---
  const slides = db.prepare('SELECT * FROM kb_slides WHERE asset_id = ? ORDER BY slide_number').all(assetId);
  const chunks = buildChunks(asset, slides);
  console.log(`[ingest]   built ${chunks.length} chunks`);

  const insertChunk = db.prepare(
    'INSERT INTO kb_chunks (asset_id, slide_id, slide_number, chunk_type, brand, asset_type, target_industry, target_objective, budget_tier, content, token_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  const insertVec = db.prepare('INSERT INTO kb_chunks_vec (chunk_id, embedding) VALUES (?, ?)');

  // Small batch so each Voyage request stays under free-tier 10K TPM (avg ~500 tokens/chunk).
  // Tune up to 32 once a Voyage payment method is on file.
  const BATCH = parseInt(process.env.VOYAGE_BATCH || '8', 10);
  let totalEmbedTokens = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vectors = await embed(batch.map(c => c.content));
    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const r = insertChunk.run(
          assetId, c.slide_id, c.slide_number, c.chunk_type,
          asset.brand, asset.asset_type, asset.target_industry, asset.target_objective, asset.budget_tier,
          c.content, c.token_count || Math.ceil(c.content.length / 4)
        );
        // sqlite-vec's vec0 virtual table requires BigInt for primary-key binding
        // (plain JS numbers error with "Only integers are allowed...").
        const chunkId = typeof r.lastInsertRowid === 'bigint' ? r.lastInsertRowid : BigInt(r.lastInsertRowid);
        const buf = floatsToBuffer(vectors[j]);
        insertVec.run(chunkId, buf);
        totalEmbedTokens += c.token_count || Math.ceil(c.content.length / 4);
      }
    });
    tx();
    process.stdout.write(`  embed ${Math.min(i + BATCH, chunks.length)}/${chunks.length}\r`);
  }
  process.stdout.write('\n');

  db.prepare("UPDATE kb_assets SET ingest_status = 'completed', ingested_at = datetime('now') WHERE id = ?").run(assetId);
  console.log(`[ingest]   done: ${chunks.length} chunks indexed, vision cost $${visionCostTotal.toFixed(4)}`);
  return { assetId, skipped: false, chunkCount: chunks.length, visionCost: visionCostTotal };
}

// ---------------------------------------------------------------
// Vision pass — single Claude call per slide with relevant context
// ---------------------------------------------------------------
async function visionPass({ userId, slideNumber, rawText, images, assetTitle, assetType, brand, rateCardMode }) {
  const client = getAnthropicClient();
  const model = getModel('vision');

  const sys = rateCardMode
    ? RATE_CARD_VISION_SYSTEM
    : GENERAL_VISION_SYSTEM;

  const content = [];
  for (const img of images) {
    if (img.buffer.length > MAX_IMAGE_BYTES) continue;
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.contentType,
        data: img.buffer.toString('base64'),
      },
    });
  }
  content.push({
    type: 'text',
    text: rateCardMode
      ? `Deck: ${assetTitle} (brand=${brand}, type=${assetType})\nSlide: ${slideNumber}\nExtracted slide text (may be partial):\n"""\n${truncate(rawText, 2000)}\n"""\n\nReturn the JSON described in the system prompt. If any number is not legible, put it in "uncertainties" — do NOT guess.`
      : `Deck: ${assetTitle} (brand=${brand}, type=${assetType})\nSlide: ${slideNumber}\nExtracted slide text:\n"""\n${truncate(rawText, 2000)}\n"""\n\nWrite the description per the system prompt. Use "unclear" for anything you can't verify from the image — never guess.`,
  });

  const res = await client.messages.create({
    model,
    max_tokens: rateCardMode ? 1500 : 700,
    system: sys,
    messages: [{ role: 'user', content }],
  });
  const text = res.content?.[0]?.text || '';
  const cost = logAICost({
    userId,
    taskType: rateCardMode ? 'vision_rate_card' : 'vision_ingest',
    model,
    inputTokens: res.usage?.input_tokens || 0,
    outputTokens: res.usage?.output_tokens || 0,
  });

  if (!rateCardMode) return { summary: text, rates: null, cost };

  // Rate-card: expect JSON. Be resilient to accidental prose wrapping.
  const json = extractJson(text);
  const summary = json?.summary || text;
  const rates = json?.line_items ? { line_items: json.line_items, uncertainties: json.uncertainties || [], currency: json.currency || null } : null;
  return { summary, rates, cost };
}

const GENERAL_VISION_SYSTEM = `You describe sales deck slides for Nuren Group's media sales AI.
You MUST NOT hallucinate. Only describe what is visible in the image and consistent with the extracted text.
If a slide contains numbers (reach, CPM, dates, percentages), transcribe them verbatim.
If anything is illegible or uncertain, write "unclear" — never invent.
Output format: 4-8 plain-text bullet points starting with "-".
Focus on: what this slide sells, which audience, which inventory/brand, key numbers, any call-to-action.`;

const RATE_CARD_VISION_SYSTEM = `You extract rate-card line items from a Nuren Group pricing slide.
ZERO-HALLUCINATION RULE: Every price, impression count, and package name MUST be legible in the image. If it isn't, put it in "uncertainties" and DO NOT guess.

Return ONE JSON object, no prose, matching:
{
  "summary": "2-3 sentence plain-language summary of what this rate card slide sells",
  "currency": "MYR" | "SGD" | "USD" | null,
  "line_items": [
    {
      "package_name": "...",
      "unit": "per post | per article | per campaign | per month | ...",
      "price": 12345,          // number; null if unclear
      "includes": "short description of what the buyer gets",
      "audience_or_reach": "e.g. 200k impressions / 50k views (verbatim from slide, else null)"
    }
  ],
  "uncertainties": ["string describing what could not be read clearly"]
}

Do not output anything outside this JSON object.`;

// ---------------------------------------------------------------
// Chunk builder — fuses text + vision summary + rates per slide
// ---------------------------------------------------------------
function buildChunks(asset, slides) {
  const chunks = [];
  for (const s of slides) {
    const parts = [];
    parts.push(`[${asset.brand.toUpperCase()} | ${asset.asset_type} | slide ${s.slide_number}] ${asset.title}`);
    if (s.raw_text && s.raw_text.trim()) parts.push(s.raw_text.trim());
    if (s.vision_summary) parts.push(`VISION:\n${s.vision_summary}`);

    // Inline rate items as readable lines so keyword+vector both surface them
    if (s.vision_rates_json) {
      try {
        const r = JSON.parse(s.vision_rates_json);
        if (r.line_items?.length) {
          const lines = r.line_items.map(li => {
            const price = li.price != null ? `${r.currency || ''} ${li.price}` : '(price unclear)';
            return `- ${li.package_name} | ${li.unit || ''} | ${price} | ${li.audience_or_reach || ''} | ${li.includes || ''}`;
          });
          parts.push(`RATE LINE ITEMS:\n${lines.join('\n')}`);
          if (r.uncertainties?.length) parts.push(`UNCERTAIN:\n- ${r.uncertainties.join('\n- ')}`);
        }
      } catch { /* ignore malformed */ }
    }

    if (s.speaker_notes && s.speaker_notes.trim()) parts.push(`NOTES:\n${s.speaker_notes.trim()}`);

    const full = parts.join('\n\n');
    // Split if oversized
    const pieces = splitForChunks(full, MAX_CHUNK_CHARS);
    for (const piece of pieces) {
      chunks.push({
        slide_id: s.id,
        slide_number: s.slide_number,
        chunk_type: s.vision_rates_json ? 'rates' : (s.vision_summary ? 'merged' : 'text'),
        content: piece,
        token_count: Math.ceil(piece.length / 4),
      });
    }
  }
  return chunks;
}

function splitForChunks(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const out = [];
  const paragraphs = text.split(/\n\n+/);
  let buf = '';
  for (const p of paragraphs) {
    if (!buf.length) { buf = p; continue; }
    if (buf.length + p.length + 2 <= maxChars) { buf += '\n\n' + p; continue; }
    out.push(buf);
    buf = p;
  }
  if (buf.length) out.push(buf);
  // Fallback hard-split for any single giant paragraph
  const safe = [];
  for (const c of out) {
    if (c.length <= maxChars) { safe.push(c); continue; }
    for (let i = 0; i < c.length; i += maxChars) safe.push(c.slice(i, i + maxChars));
  }
  return safe;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '… [truncated]';
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

function floatsToBuffer(vec) {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
