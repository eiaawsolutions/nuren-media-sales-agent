import Anthropic from '@anthropic-ai/sdk';
import db from '../db/index.js';
import { decrypt } from './crypto.js';
import { config } from '../config/index.js';

// Model pricing per 1M tokens (USD) — Claude 4.x family as of 2026-04
const MODEL_PRICING = {
  'claude-opus-4-7':           { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00  },
};
const WEB_SEARCH_COST = 0.01; // $10 per 1000 queries

export function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

export function getAnthropicClient() {
  const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
  const apiKey = keyRow?.value ? decrypt(keyRow.value) : config.anthropicApiKey;
  if (!apiKey) throw new Error('Anthropic API key not configured. Set in Settings.');
  return new Anthropic({ apiKey });
}

export function getModel(purpose = 'default') {
  const map = {
    default: 'ai_model_default',
    objection: 'ai_model_objection',
    enrichment: 'ai_model_enrichment',
    vision: 'ai_model_vision',
  };
  return getSetting(map[purpose] || 'ai_model_default', 'claude-sonnet-4-6');
}

export function calculateCost(model, inputTokens = 0, outputTokens = 0, webSearchRequests = 0) {
  const p = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-6'];
  return (inputTokens * p.input / 1_000_000)
       + (outputTokens * p.output / 1_000_000)
       + (webSearchRequests * WEB_SEARCH_COST);
}

export function logAICost({ userId, campaignId, taskType, model, inputTokens = 0, outputTokens = 0, webSearchRequests = 0, costOverride }) {
  // costOverride lets non-Anthropic sources (Apollo, enrichment APIs) log
  // flat-rate costs without going through token math.
  const cost = typeof costOverride === 'number' ? costOverride : calculateCost(model, inputTokens, outputTokens, webSearchRequests);
  db.prepare(
    'INSERT INTO ai_cost_log (user_id, campaign_id, task_type, model, input_tokens, output_tokens, total_tokens, cost_usd, web_search_requests) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(userId || null, campaignId || null, taskType, model, inputTokens, outputTokens, inputTokens + outputTokens, cost, webSearchRequests);
  return cost;
}

export function checkBudget(campaignId) {
  if (!campaignId) return true;
  const cmp = db.prepare('SELECT budget_limit FROM campaigns WHERE id = ?').get(campaignId);
  if (!cmp || !cmp.budget_limit || cmp.budget_limit <= 0) return true;
  const spent = db.prepare('SELECT COALESCE(SUM(cost_usd),0) as t FROM ai_cost_log WHERE campaign_id = ?').get(campaignId);
  if (spent.t >= cmp.budget_limit) {
    throw new Error(`Campaign budget reached ($${spent.t.toFixed(4)} / $${cmp.budget_limit.toFixed(2)}). Raise cap in campaign settings to continue.`);
  }
  return true;
}

/**
 * Voyage embeddings client — Nuren uses Voyage for RAG because it pairs cleanly
 * with Claude and supports the 1024-dim `voyage-3-lite` model.
 * Falls back to a deterministic hash-based pseudo-embedding if no key is set
 * (keeps dev working; RAG quality will be poor until a real key is added).
 *
 * Auto-throttles on 429 / rate-limit / "payment method" errors with exponential
 * backoff so free-tier (3 RPM / 10K TPM) deploys don't blow up on batch ingest.
 */
const EMBED_RATE_GAP_MS = parseInt(process.env.VOYAGE_RATE_GAP_MS || '6500', 10); // ~9 RPM ceiling; safely < 3 RPM burst
let _lastEmbedAt = 0;

export async function embed(texts, { retries = 5 } = {}) {
  const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'voyage_api_key'").get();
  const apiKey = keyRow?.value ? decrypt(keyRow.value) : process.env.VOYAGE_API_KEY;
  // `voyage-3-large` is the default because it honors `output_dimension` and
  // returns 1024-dim vectors, matching the FLOAT[1024] schema in kb_chunks_vec.
  // `voyage-3-lite` silently ignores `output_dimension` and always returns 512
  // dims, which breaks vector inserts — do NOT switch back without also
  // recreating the vec table at the new dim.
  const model = getSetting('embedding_model', 'voyage-3-large');
  const dim = parseInt(getSetting('embedding_dim', '1024'), 10);

  const input = Array.isArray(texts) ? texts : [texts];

  if (!apiKey) {
    console.warn('[embed] VOYAGE_API_KEY missing — using hash pseudo-embeddings (dev only).');
    return input.map(t => pseudoEmbed(t, dim));
  }

  // Throttle — enforce a minimum gap between Voyage calls to stay within free-tier RPM
  const waitMs = Math.max(0, EMBED_RATE_GAP_MS - (Date.now() - _lastEmbedAt));
  if (waitMs > 0) await sleep(waitMs);
  _lastEmbedAt = Date.now();

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // `output_dimension` pins the vector size so it always matches our
    // kb_chunks_vec schema (FLOAT[1024]). Voyage 3 family defaults to 1024
    // for most models but `voyage-3-lite` has historically returned 512 as
    // default — explicit is safer than implicit.
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, model, input_type: 'document', output_dimension: dim }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data.data.map(d => d.embedding);

    const msg = data.detail || data.message || data.error || `Voyage error ${res.status}`;
    lastErr = new Error(msg);
    // Retry on 429, rate-limit language, or payment-method / free-tier warnings
    const retryable = res.status === 429 || res.status >= 500 || /rate.?limit|payment method|reduced rate limits|TPM|RPM/i.test(String(msg));
    if (!retryable || attempt === retries) throw lastErr;
    const backoff = Math.min(30_000, 2000 * Math.pow(2, attempt)); // 2s, 4s, 8s, 16s, 30s
    console.warn(`[embed] retryable error (${msg.slice(0, 120)}); backing off ${backoff}ms (attempt ${attempt + 1}/${retries})`);
    await sleep(backoff);
    _lastEmbedAt = Date.now();
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pseudoEmbed(text, dim) {
  // Deterministic hash-based vector for dev use only — NOT semantic.
  const out = new Float32Array(dim);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    out[h >>> 0 & (dim - 1)] += Math.sin(h) * 0.1;
  }
  // Normalize
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += out[i] * out[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < dim; i++) out[i] /= mag;
  return Array.from(out);
}
