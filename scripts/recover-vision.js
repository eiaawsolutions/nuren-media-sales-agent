// Recover Vision for any deck where >30% of slides are missing vision_summary.
// Also ingests any *.pptx in KB_DIR not yet in kb_assets.
// Force=true → wipes existing slides + chunks → full Vision re-run → real cost.
import fs from 'fs';
import path from 'path';
import db from '../src/db/index.js';
import { ingestPptx } from '../src/services/kb-ingest.js';
import { config } from '../src/config/index.js';

const KB_DIR = config.kbDir || path.join(config.dataDir, 'knowledge-base');

// 1. Decks with substantial Vision gaps → force-reingest.
// Include 'failed' rows too — those are decks we've intentionally reset to be
// retried (e.g., after a race-condition UNIQUE-constraint abort).
const gaps = db.prepare(`
  SELECT a.id, a.filename, a.slide_count,
         (SELECT COUNT(*) FROM kb_slides s WHERE s.asset_id = a.id AND s.vision_summary IS NOT NULL) AS v_ok,
         (SELECT COUNT(*) FROM kb_slides s WHERE s.asset_id = a.id) AS sd
  FROM kb_assets a
  WHERE a.ingest_status IN ('completed', 'failed', 'vision', 'embedding', 'parsing')
`).all()
  .filter(r => {
    const expected = Math.max(r.slide_count || r.sd, 1);
    const coverage = r.v_ok / expected;
    return coverage < 0.7;
  });

console.log(`[recover] ${gaps.length} deck(s) with <70% Vision coverage, will force-reingest:`);
for (const g of gaps) console.log(`  #${g.id} ${g.filename} (${g.v_ok}/${g.slide_count})`);

// 2. Uningested pptx files → ingest fresh
const existingNames = new Set(db.prepare('SELECT filename FROM kb_assets').all().map(r => r.filename));
const untouched = fs.readdirSync(KB_DIR)
  .filter(f => /\.pptx$/i.test(f))
  .filter(f => !existingNames.has(f))
  .sort();

console.log(`[recover] ${untouched.length} uningested deck(s):`);
for (const f of untouched) console.log(`  - ${f}`);

let spent = 0;
let failures = [];

// 3. Run force-reingest on gap decks
for (const g of gaps) {
  const p = path.join(KB_DIR, g.filename);
  if (!fs.existsSync(p)) { console.warn(`  !! source missing for #${g.id}: ${p}`); continue; }
  console.log(`\n[recover] FORCE-REINGEST #${g.id} ${g.filename}`);
  try {
    const r = await ingestPptx(p, { force: true });
    spent += r.visionCost || 0;
    console.log(`[recover]   done: chunks=${r.chunkCount} visionCost=$${(r.visionCost||0).toFixed(4)}`);
  } catch (err) {
    console.error(`[recover]   FAILED: ${err.message}`);
    failures.push({ id: g.id, filename: g.filename, err: err.message });
  }
}

// 4. Run fresh-ingest on uningested
for (const f of untouched) {
  const p = path.join(KB_DIR, f);
  console.log(`\n[recover] FRESH INGEST ${f}`);
  try {
    const r = await ingestPptx(p, { force: false });
    spent += r.visionCost || 0;
    console.log(`[recover]   done: chunks=${r.chunkCount} visionCost=$${(r.visionCost||0).toFixed(4)}`);
  } catch (err) {
    console.error(`[recover]   FAILED: ${err.message}`);
    failures.push({ filename: f, err: err.message });
  }
}

console.log(`\n[recover] SUMMARY: $${spent.toFixed(4)} new Vision spend | ${failures.length} failures`);
if (failures.length) console.log(JSON.stringify(failures, null, 2));

const byStatus = db.prepare("SELECT ingest_status, COUNT(*) AS c FROM kb_assets GROUP BY ingest_status").all();
console.log('final by_status:', byStatus);

const cov = db.prepare(`
  SELECT a.id, a.filename, a.slide_count,
         (SELECT COUNT(*) FROM kb_slides s WHERE s.asset_id = a.id AND s.vision_summary IS NOT NULL) AS v_ok
  FROM kb_assets a
  WHERE a.ingest_status = 'completed'
  ORDER BY a.id
`).all();
console.log('\nVision coverage per deck:');
for (const r of cov) {
  const pct = Math.round(100 * r.v_ok / Math.max(r.slide_count, 1));
  console.log(`  #${r.id} ${pct}% (${r.v_ok}/${r.slide_count}) ${r.filename}`);
}

process.exit(0);
