import { Router } from 'express';
import db from '../db/index.js';
import { requireAuth, requireSuperadmin } from '../middleware/auth.js';
import { encrypt, decrypt, isSensitive, SENSITIVE_KEYS } from '../utils/crypto.js';
import { UNENRICHED_WHERE_FRAGMENT } from '../services/leads.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  const out = {};
  for (const r of rows) {
    if (isSensitive(r.key)) {
      const v = decrypt(r.value);
      out[r.key] = v ? '•••••• (set)' : '';
    } else {
      out[r.key] = r.value;
    }
  }
  res.json(out);
});

router.put('/', requireSuperadmin, (req, res) => {
  const body = req.body || {};
  const upsert = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')");
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      if (v === undefined || v === null) continue;
      if (isSensitive(k) && typeof v === 'string' && v.includes('•')) continue; // don't overwrite masked values
      const stored = isSensitive(k) ? encrypt(String(v)) : String(v);
      upsert.run(k, stored);
    }
  });
  tx(Object.entries(body));
  res.json({ success: true, sensitive_keys: SENSITIVE_KEYS });
});

// ============================================================
// DATABASE CLEANUP — purge unenriched leads (no reachable contact)
// "Unenriched" = no real email AND no phone AND no real linkedin/in/
// profile. These rows have zero outreach paths and pollute search +
// dedup. Removes legacy pseudo-email leads (@noemail.leads.local etc.)
// and AI-generated rows that slipped past the verification gate.
// ============================================================
router.get('/cleanup/unenriched-preview', (req, res) => {
  const { count } = db.prepare(
    `SELECT COUNT(*) AS count FROM leads WHERE user_id = ? AND ${UNENRICHED_WHERE_FRAGMENT}`
  ).get(req.user.id);
  const sample = db.prepare(
    `SELECT id, name, email, phone, linkedin_url, source, created_at
     FROM leads WHERE user_id = ? AND ${UNENRICHED_WHERE_FRAGMENT}
     ORDER BY created_at DESC LIMIT 10`
  ).all(req.user.id);
  res.json({ count, sample });
});

router.post('/cleanup/unenriched', requireSuperadmin, (req, res) => {
  const userId = req.user.id;
  // Resolve target ids first; cascade through every table that references
  // leads.id, then drop the leads. Schema only cascades on accounts→leads
  // and campaign_leads — everything else needs explicit deletes.
  const targets = db.prepare(
    `SELECT id FROM leads WHERE user_id = ? AND ${UNENRICHED_WHERE_FRAGMENT}`
  ).all(userId).map(r => r.id);

  if (targets.length === 0) return res.json({ deleted: 0, cascaded: {} });

  const placeholders = targets.map(() => '?').join(',');
  const tx = db.transaction(() => {
    const stats = {};
    const tableExists = (name) =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);

    if (tableExists('campaign_leads')) {
      stats.campaign_leads = db.prepare(`DELETE FROM campaign_leads WHERE lead_id IN (${placeholders})`).run(...targets).changes;
    }
    if (tableExists('outreach_queue')) {
      stats.outreach_queue = db.prepare(`DELETE FROM outreach_queue WHERE lead_id IN (${placeholders})`).run(...targets).changes;
    }
    stats.messages = db.prepare(`DELETE FROM messages WHERE lead_id IN (${placeholders})`).run(...targets).changes;
    stats.sequence_enrollments = db.prepare(`DELETE FROM sequence_enrollments WHERE lead_id IN (${placeholders})`).run(...targets).changes;
    stats.activities = db.prepare(`DELETE FROM activities WHERE lead_id IN (${placeholders})`).run(...targets).changes;
    stats.pipeline = db.prepare(`DELETE FROM pipeline WHERE lead_id IN (${placeholders})`).run(...targets).changes;
    stats.appointments = db.prepare(`DELETE FROM appointments WHERE lead_id IN (${placeholders})`).run(...targets).changes;
    stats.leads = db.prepare(`DELETE FROM leads WHERE id IN (${placeholders}) AND user_id = ?`).run(...targets, userId).changes;
    return stats;
  });

  const cascaded = tx();
  console.log(`[settings/cleanup/unenriched] user=${userId} purged ${cascaded.leads} leads, cascaded:`, cascaded);
  res.json({ deleted: cascaded.leads, cascaded });
});

export default router;
