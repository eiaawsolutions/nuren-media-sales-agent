// Probe: what embedding model is configured and what dim do stored vectors have?
import Database from 'better-sqlite3';
const db = new Database('/app/data/agent.db', { readonly: true });

const s = db.prepare(
  "SELECT key, CASE WHEN key IN ('api_key','voyage_api_key','resend_api_key','smtp_pass','encryption_key') THEN '<redacted>' ELSE value END AS value FROM settings WHERE key IN ('embedding_model','embedding_dim','voyage_api_key','api_key')"
).all();
console.log('settings:', JSON.stringify(s, null, 2));

console.log('kb_chunks rows:', db.prepare('SELECT COUNT(*) AS c FROM kb_chunks').get());
console.log('kb_chunks_vec rows:', db.prepare('SELECT COUNT(*) AS c FROM kb_chunks_vec').get());

try {
  const dims = db.prepare('SELECT length(embedding)/4 AS floats FROM kb_chunks_vec LIMIT 3').all();
  console.log('sample vec float-counts:', dims);
} catch (e) {
  console.log('dim probe err:', e.message);
}

// How many chunks belong to the completed first deck vs the failed decks?
const byAsset = db.prepare(`
  SELECT a.id, a.filename, a.ingest_status,
         (SELECT COUNT(*) FROM kb_chunks c WHERE c.asset_id = a.id) AS chunks,
         (SELECT COUNT(*) FROM kb_chunks_vec v WHERE v.chunk_id IN (SELECT id FROM kb_chunks WHERE asset_id = a.id)) AS vecs
  FROM kb_assets a ORDER BY a.id
`).all();
console.log('per-asset chunks vs vecs:', JSON.stringify(byAsset, null, 2));
