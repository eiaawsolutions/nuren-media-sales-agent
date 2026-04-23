import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import db from '../db/index.js';
import { ingestPptx } from '../services/kb-ingest.js';
import { retrieve } from '../services/rag.js';
import { config } from '../config/index.js';

const router = Router();
// On Railway, a persistent volume is mounted at /app/data. We put KB inside it
// so uploaded PPTXs survive deploys. Local dev falls back to ./knowledge-base.
const KB_DIR = config.kbDir || (config.dataDir
  ? path.join(config.dataDir, 'knowledge-base')
  : path.join(path.resolve(), 'knowledge-base'));
fs.mkdirSync(KB_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: KB_DIR,
    filename: (_req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

router.get('/assets', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.asset_id = a.id) AS chunk_count
    FROM kb_assets a
    ORDER BY a.created_at DESC
  `).all();
  res.json(rows);
});

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const result = await ingestPptx(req.file.path, { userId: req.user.id, force: req.query.force === '1' });
    res.json({ success: true, ...result });
  } catch (err) {
    const filename = req.file.originalname;
    const existing = db.prepare('SELECT id FROM kb_assets WHERE filename = ?').get(filename);
    if (existing) db.prepare("UPDATE kb_assets SET ingest_status = 'failed', ingest_error = ? WHERE id = ?").run(err.message, existing.id);
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest-dir', async (req, res) => {
  const { dir, force } = req.body || {};
  if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: 'dir does not exist' });
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pptx'));
  res.json({ queued: files.length, note: 'Ingestion runs in background. Poll /api/knowledge/assets for status.' });
  // Fire-and-forget with sequential processing (vision calls serialize naturally)
  (async () => {
    for (const f of files) {
      try { await ingestPptx(path.join(dir, f), { userId: req.user.id, force: !!force }); }
      catch (err) { console.error(`[ingest-dir] ${f}:`, err.message); }
    }
  })();
});

/**
 * POST /api/knowledge/reingest/:id
 * Query params:
 *   force=1  — wipe slides + redo Vision from scratch (expensive!)
 *   default  — resume-safe: if existing slides + matching sha256, skip Vision
 *              and only (re-)run the embedding step. Preserves vision_cost_usd.
 */
router.post('/reingest/:id', async (req, res) => {
  const asset = db.prepare('SELECT * FROM kb_assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'asset not found' });
  const p = path.join(KB_DIR, asset.filename);
  if (!fs.existsSync(p)) return res.status(400).json({ error: `source file missing: ${asset.filename}` });
  try {
    const result = await ingestPptx(p, { userId: req.user.id, force: req.query.force === '1' });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/asset/:id', (req, res) => {
  const r = db.prepare('DELETE FROM kb_assets WHERE id = ?').run(req.params.id);
  res.json({ deleted: r.changes });
});

router.get('/search', async (req, res) => {
  const {
    q = '', brand, asset_type, industry, objective, budget, topK,
  } = req.query;
  try {
    const hits = await retrieve(q, {
      brand: brand || null,
      asset_type: asset_type || null,
      target_industry: industry || null,
      target_objective: objective || null,
      budget_tier: budget || null,
      topK: Math.min(parseInt(topK || '8', 10), 20),
    });
    res.json({ query: q, count: hits.length, hits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', (req, res) => {
  const assets = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(slide_count),0) AS slides, COALESCE(SUM(vision_cost_usd),0) AS vision_cost FROM kb_assets').get();
  const chunks = db.prepare('SELECT COUNT(*) as c FROM kb_chunks').get();
  const byBrand = db.prepare('SELECT brand, COUNT(*) AS c FROM kb_assets GROUP BY brand').all();
  const byType = db.prepare('SELECT asset_type, COUNT(*) AS c FROM kb_assets GROUP BY asset_type').all();
  const byStatus = db.prepare('SELECT ingest_status, COUNT(*) AS c FROM kb_assets GROUP BY ingest_status').all();
  res.json({ assets, chunks, byBrand, byType, byStatus });
});

export default router;
