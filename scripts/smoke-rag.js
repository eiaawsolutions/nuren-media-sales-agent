#!/usr/bin/env node
import 'dotenv/config';
import { retrieve, formatContext } from '../src/services/rag.js';

const q = process.argv.slice(2).join(' ') || 'What is the KOL rate card for an FMCG baby skincare brand?';
console.log(`Q: ${q}\n`);

const hits = await retrieve(q, { topK: 5 });
if (!hits.length) {
  console.log('No results. Did you ingest any PPTX yet? Run: npm run ingest:all');
  process.exit(0);
}
for (const h of hits) {
  console.log(`--- score ${h.score.toFixed(4)}  [${h.brand}|${h.asset_type}|slide ${h.slide_number}] ${h.filename}`);
  console.log(h.content.slice(0, 400).replace(/\n/g, ' ') + (h.content.length > 400 ? '…' : ''));
  console.log();
}
