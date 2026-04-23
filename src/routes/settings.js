import { Router } from 'express';
import db from '../db/index.js';
import { requireAuth, requireSuperadmin } from '../middleware/auth.js';
import { encrypt, decrypt, isSensitive, SENSITIVE_KEYS } from '../utils/crypto.js';

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

export default router;
