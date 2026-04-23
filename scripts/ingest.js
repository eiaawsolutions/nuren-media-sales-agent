#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ingestPptx } from '../src/services/kb-ingest.js';
import { config } from '../src/config/index.js';

/**
 * CLI: node scripts/ingest.js <file.pptx>            — ingest one file
 *      node scripts/ingest.js --all                   — ingest every .pptx in config.kbSourceDir
 *      node scripts/ingest.js --dir <path>            — ingest every .pptx in given dir
 *      node scripts/ingest.js --force <file.pptx>     — re-ingest (drops old chunks)
 */
const args = process.argv.slice(2);
const force = args.includes('--force');
const cleaned = args.filter(a => a !== '--force');

async function main() {
  let files = [];
  if (cleaned.includes('--all')) {
    if (!config.kbSourceDir || !fs.existsSync(config.kbSourceDir)) {
      console.error('KB_SOURCE_DIR not set or missing. Set in .env or use --dir <path>.');
      process.exit(1);
    }
    files = fs.readdirSync(config.kbSourceDir).filter(f => f.toLowerCase().endsWith('.pptx')).map(f => path.join(config.kbSourceDir, f));
  } else if (cleaned[0] === '--dir' && cleaned[1]) {
    const dir = cleaned[1];
    if (!fs.existsSync(dir)) { console.error(`Dir not found: ${dir}`); process.exit(1); }
    files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pptx')).map(f => path.join(dir, f));
  } else if (cleaned[0]) {
    files = [cleaned[0]];
  } else {
    console.error('Usage: node scripts/ingest.js <file.pptx> | --all | --dir <path> [--force]');
    process.exit(1);
  }

  console.log(`Queued ${files.length} file(s). Force=${force}`);
  let okCount = 0, skipCount = 0, failCount = 0, totalVisionCost = 0;
  const started = Date.now();

  for (const f of files) {
    try {
      const r = await ingestPptx(f, { force });
      if (r.skipped) skipCount++;
      else { okCount++; totalVisionCost += r.visionCost || 0; }
    } catch (err) {
      console.error(`FAIL ${path.basename(f)}: ${err.message}`);
      failCount++;
    }
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n=== SUMMARY ===`);
  console.log(`ok: ${okCount}  skipped: ${skipCount}  failed: ${failCount}`);
  console.log(`vision cost: $${totalVisionCost.toFixed(4)}  elapsed: ${mins} min`);
}

main().catch(err => { console.error(err); process.exit(1); });
