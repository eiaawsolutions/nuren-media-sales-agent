import { Router } from 'express';
import multer from 'multer';
import db from '../db/index.js';
import { parseCsv } from '../utils/csv.js';
import { persistLead, getLead, listLeads, unenrichedFragment } from '../services/leads.js';
import { enrichLead } from '../services/lead-enrichment.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/', (req, res) => {
  res.json(listLeads(req.user.id, req.query));
});

/** GET /api/leads/_/hidden-count — how many leads are hidden by the enrichment guard */
router.get('/_/hidden-count', (req, res) => {
  const { count } = db.prepare(
    `SELECT COUNT(*) AS count FROM leads WHERE user_id = ? AND ${unenrichedFragment('')}`
  ).get(req.user.id);
  res.json({ count });
});

router.get('/rejected', (req, res) => {
  const rows = db.prepare('SELECT * FROM leads_rejected WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(req.user.id);
  for (const r of rows) {
    try { r.raw_input = JSON.parse(r.raw_input); } catch {}
    try { r.reasons = JSON.parse(r.reasons); } catch {}
  }
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const l = getLead(req.params.id, req.user.id);
  if (!l) return res.status(404).json({ error: 'Lead not found' });
  res.json(l);
});

router.post('/', (req, res) => {
  const result = persistLead(req.body || {}, { userId: req.user.id, source: 'manual' });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

/**
 * POST /api/leads/upload  — multipart CSV
 * Accepted columns (all optional except name+company): name, title, email, phone,
 * company, company_website, linkedin_url, persona, type, lead_type, confidence_score,
 * verification_sources, reason_for_fit, buying_signal, industry, geography, notes.
 *
 * If `?enrich=1` is passed, each raw row is run through AI enrichment first.
 * Otherwise, rows go straight to the verification gate + persist (rejecting any
 * that lack verification evidence — per Lead Gen Contract).
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const shouldEnrich = req.query.enrich === '1';

  let rows;
  try {
    rows = parseCsv(req.file.buffer.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'CSV parse failed: ' + err.message });
  }
  if (!rows.length) return res.status(400).json({ error: 'CSV empty or headers missing' });

  const report = { total: rows.length, persisted: 0, updated: 0, rejected: 0, enriched: 0, errors: [] };
  res.json({ queued: rows.length, enrich: shouldEnrich, note: 'Processing in background. Poll /api/leads for results or /api/leads/rejected for failures.' });

  (async () => {
    for (const row of rows) {
      try {
        let input = row;
        if (shouldEnrich) {
          const e = await enrichLead({
            name: row.name, company: row.company,
            email: row.email, linkedin_url: row.linkedin_url, company_website: row.company_website,
            hint: row.notes || row.reason_for_fit,
          }, { userId: req.user.id });
          report.enriched++;
          if (!e.ok) {
            db.prepare("INSERT INTO leads_rejected (user_id, raw_input, reasons, source) VALUES (?,?,?,?)")
              .run(req.user.id, JSON.stringify(row), JSON.stringify(e.reasons), 'csv_enrichment');
            report.rejected++;
            continue;
          }
          input = { ...row, ...e.lead };
        }
        const r = persistLead(input, { userId: req.user.id, source: shouldEnrich ? 'ai_enrichment' : 'csv_upload' });
        if (!r.ok) report.rejected++;
        else if (r.updated) report.updated++;
        else report.persisted++;
      } catch (err) {
        report.errors.push(err.message);
        console.error('[leads/upload] row error:', err.message);
      }
    }
    console.log('[leads/upload] done:', report);
  })();
});

/** POST /api/leads/:id/enrich — re-run AI enrichment on an existing lead */
router.post('/:id/enrich', async (req, res) => {
  const current = getLead(req.params.id, req.user.id);
  if (!current) return res.status(404).json({ error: 'Lead not found' });
  try {
    const e = await enrichLead({
      name: current.name,
      company: current.account_name,
      email: current.email,
      linkedin_url: current.linkedin_url,
      company_website: current.company_website,
    }, { userId: req.user.id });
    if (!e.ok) return res.status(422).json({ ok: false, reasons: e.reasons, raw: e.raw });
    const r = persistLead({ ...current, ...e.lead }, { userId: req.user.id, source: 'ai_enrichment' });
    res.json({ ok: true, ...r, webSearchUses: e.webSearchUses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM leads WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ deleted: r.changes });
});

export default router;
