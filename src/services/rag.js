import db from '../db/index.js';
import { embed } from '../utils/anthropic.js';

/**
 * Hybrid retrieval: vector (kb_chunks_vec) + FTS5 keyword (kb_chunks_fts).
 * Reciprocal Rank Fusion merges the two ranked lists.
 *
 * filters: { brand, asset_type, target_industry, target_objective, budget_tier }
 *   - each filter is applied post-rank to both streams
 *   - passing 'any' or undefined skips that filter
 */
export async function retrieve(query, {
  topK = 8,
  brand = null,
  asset_type = null,
  target_industry = null,
  target_objective = null,
  budget_tier = null,
  candidateK = 40,
} = {}) {
  if (!query || !query.trim()) return [];

  // --- Vector search ---
  let vecHits = [];
  try {
    const [qvec] = await embed([query]);
    const qbuf = Buffer.from(new Float32Array(qvec).buffer);
    vecHits = db.prepare(`
      SELECT c.id, c.asset_id, c.slide_number, c.chunk_type, c.brand, c.asset_type, c.target_industry, c.target_objective, c.budget_tier, c.content,
             v.distance
      FROM kb_chunks_vec v
      JOIN kb_chunks c ON c.id = v.chunk_id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `).all(qbuf, candidateK);
  } catch (err) {
    console.warn('[rag] vector search failed:', err.message);
  }

  // --- Keyword search (FTS5) ---
  let ftsHits = [];
  try {
    // Escape FTS5 special chars and wrap quoted phrase for safety
    const ftsQuery = sanitizeFts(query);
    ftsHits = db.prepare(`
      SELECT c.id, c.asset_id, c.slide_number, c.chunk_type, c.brand, c.asset_type, c.target_industry, c.target_objective, c.budget_tier, c.content,
             bm25(kb_chunks_fts) AS rank
      FROM kb_chunks_fts
      JOIN kb_chunks c ON c.id = kb_chunks_fts.rowid
      WHERE kb_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, candidateK);
  } catch (err) {
    console.warn('[rag] fts search failed:', err.message);
  }

  const filters = { brand, asset_type, target_industry, target_objective, budget_tier };
  const passesFilters = (row) => {
    for (const [k, v] of Object.entries(filters)) {
      if (!v || v === 'any') continue;
      if (row[k] !== v && row[k] !== 'any') return false;
    }
    return true;
  };

  // --- Reciprocal Rank Fusion ---
  const K = 60;
  const scores = new Map();
  vecHits.forEach((h, i) => {
    if (!passesFilters(h)) return;
    scores.set(h.id, { row: h, score: (scores.get(h.id)?.score || 0) + 1 / (K + i + 1) });
  });
  ftsHits.forEach((h, i) => {
    if (!passesFilters(h)) return;
    const prev = scores.get(h.id);
    scores.set(h.id, { row: prev?.row || h, score: (prev?.score || 0) + 1 / (K + i + 1) });
  });

  const merged = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Attach asset metadata for citation
  const out = [];
  for (const { row, score } of merged) {
    const asset = db.prepare('SELECT filename, title FROM kb_assets WHERE id = ?').get(row.asset_id);
    out.push({
      chunk_id: row.id,
      asset_id: row.asset_id,
      filename: asset?.filename,
      title: asset?.title,
      slide_number: row.slide_number,
      brand: row.brand,
      asset_type: row.asset_type,
      target_industry: row.target_industry,
      target_objective: row.target_objective,
      chunk_type: row.chunk_type,
      content: row.content,
      score,
    });
  }
  return out;
}

function sanitizeFts(q) {
  // FTS5 doesn't like stray punctuation; take word tokens and OR them plus a phrase for fidelity.
  const words = q.toLowerCase().match(/[a-z0-9]+/g) || [];
  if (!words.length) return '""';
  const unique = [...new Set(words)].slice(0, 10);
  // Phrase boost if 2+ words
  const phrase = unique.length > 1 ? `"${unique.join(' ')}" OR ` : '';
  return phrase + unique.join(' OR ');
}

/** Format top chunks as a RAG context block for the LLM. */
export function formatContext(chunks) {
  if (!chunks.length) return '';
  return chunks.map((c, i) => (
    `[Source ${i + 1}] ${c.title || c.filename} — slide ${c.slide_number} (${c.brand} · ${c.asset_type})\n${c.content}`
  )).join('\n\n---\n\n');
}
