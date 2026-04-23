// One-shot: re-embed every kb_asset still in 'failed' state. Runs
// inside Railway via `railway ssh`. Uses the resume path in ingestPptx
// (Vision cached on /app/data/knowledge-base), so cost is ~$0 per deck.
import path from 'path';
import fs from 'fs';
import db from '../src/db/index.js';
import { ingestPptx } from '../src/services/kb-ingest.js';
import { config } from '../src/config/index.js';

const KB_DIR = config.kbDir || path.join(config.dataDir, 'knowledge-base');

const failed = db.prepare("SELECT id, filename FROM kb_assets WHERE ingest_status = 'failed' ORDER BY id").all();
console.log(`[reingest] found ${failed.length} failed asset(s):`, failed.map(a => `${a.id}:${a.filename}`).join(', '));

for (const a of failed) {
  const p = path.join(KB_DIR, a.filename);
  if (!fs.existsSync(p)) {
    console.warn(`[reingest] source missing for id ${a.id}: ${p} — skipping`);
    continue;
  }
  try {
    const r = await ingestPptx(p, { force: false });
    console.log(`[reingest] id ${a.id} -> ok:`, r);
  } catch (err) {
    console.error(`[reingest] id ${a.id} FAILED:`, err.message);
  }
}

const after = db.prepare("SELECT ingest_status, COUNT(*) AS c FROM kb_assets GROUP BY ingest_status").all();
console.log(`[reingest] final status:`, after);
process.exit(0);
