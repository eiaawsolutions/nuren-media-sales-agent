import db from '../src/db/index.js';

// One-shot dedup cleanup — collapses duplicate leads into one canonical row
// per layered dedup key, remapping foreign references (campaign_leads,
// sequence_enrollments, activities, messages, drafts) so nothing is lost.
//
// Canonical = the lowest id in each dup group (oldest row wins).
//
// DRY-RUN is on by default — the script prints what it would do but makes no
// changes. Pass APPLY=1 to actually execute. Always idempotent: running again
// after APPLY finds nothing to collapse.

const APPLY = process.env.APPLY === '1';

function linkedinHandle(url) {
  if (!url || typeof url !== 'string') return '';
  const m = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? m[1].toLowerCase().replace(/\/$/, '') : '';
}

function slug(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '').trim();
}

// Build ALL dedup keys a lead matches (not just the highest-precedence one).
// Different leads may anchor on different keys — Putri id=25 has apollo_id,
// Putri id=27 doesn't — so the cleanup needs to find them via the shared
// LinkedIn handle even though their top-precedence keys differ.
function allKeys(row, enr) {
  const keys = [];
  if (enr?.apollo_id) keys.push('apollo:' + enr.apollo_id);
  const h = linkedinHandle(row.linkedin_url);
  if (h) keys.push('li:' + h);
  if (row.email) keys.push('em:' + row.email.toLowerCase());
  const nameKey = slug(row.name);
  const companyKey = slug(row.account_name || '');
  if (nameKey && companyKey) keys.push('nc:' + nameKey + ':' + companyKey);
  return keys;
}

const allLeads = db.prepare(`
  SELECT l.id, l.user_id, l.name, l.email, l.linkedin_url, l.enrichment, a.name AS account_name
  FROM leads l LEFT JOIN accounts a ON a.id = l.account_id
  ORDER BY l.user_id, l.id
`).all();

// Union-find: two rows are in the same dup group if they share ANY key.
// Transitive: if A shares apollo_id with B, and B shares linkedin with C,
// all three collapse into one group.
const parent = new Map(); // leadId -> root leadId
function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, Math.min(ra, rb) === ra ? ra : rb); if (Math.max(ra, rb) !== Math.min(ra, rb)) parent.set(Math.max(ra, rb), Math.min(ra, rb)); }

// Seed each lead as its own root
for (const row of allLeads) parent.set(row.id, row.id);

// Build a per-user key → first-lead-id map; any second hit unions
const keyToLead = new Map(); // `${userId}|${key}` -> leadId
for (const row of allLeads) {
  let enr = null;
  try { enr = row.enrichment ? JSON.parse(row.enrichment) : null; } catch {}
  const keys = allKeys(row, enr);
  for (const k of keys) {
    const mapKey = row.user_id + '|' + k;
    const prior = keyToLead.get(mapKey);
    if (prior != null) union(prior, row.id);
    else keyToLead.set(mapKey, row.id);
  }
}

// Collect groups by root
const groupsByRoot = new Map();
for (const row of allLeads) {
  const r = find(row.id);
  if (!groupsByRoot.has(r)) groupsByRoot.set(r, []);
  groupsByRoot.get(r).push(row);
}

const dupGroups = [];
for (const [root, rows] of groupsByRoot) {
  if (rows.length > 1) {
    rows.sort((a, b) => a.id - b.id);
    dupGroups.push({ userId: rows[0].user_id, key: 'root:' + root, rows });
  }
}

console.log(`Found ${dupGroups.length} duplicate groups.`);
if (!dupGroups.length) {
  console.log('Nothing to collapse.');
  process.exit(0);
}

// Print plan
for (const { userId, key, rows } of dupGroups) {
  const canonical = rows[0];
  const toKill = rows.slice(1);
  console.log(`\nuser=${userId} key=${key}`);
  console.log(`  KEEP  id=${canonical.id} "${canonical.name}" email=${canonical.email || '-'} li=${linkedinHandle(canonical.linkedin_url) || '-'}`);
  for (const k of toKill) {
    console.log(`  KILL  id=${k.id} "${k.name}" email=${k.email || '-'} li=${linkedinHandle(k.linkedin_url) || '-'}`);
  }
}

if (!APPLY) {
  console.log('\n(dry run — set APPLY=1 to execute)');
  process.exit(0);
}

// Remap helpers — moves FK refs from killId to keepId, ignoring UNIQUE conflicts
// (e.g. both rows enrolled in same sequence → we drop the dup enrollment).
function remap(table, fkCol, killId, keepId) {
  try {
    const r = db.prepare(`UPDATE OR IGNORE ${table} SET ${fkCol} = ? WHERE ${fkCol} = ?`).run(keepId, killId);
    // Any rows that hit UNIQUE conflict on the UPDATE OR IGNORE get left pointing at killId;
    // delete those now so they don't become orphans when killId is removed.
    const del = db.prepare(`DELETE FROM ${table} WHERE ${fkCol} = ?`).run(killId);
    return { moved: r.changes, discarded_conflicts: del.changes };
  } catch (err) {
    console.warn(`  remap failed for ${table}.${fkCol}: ${err.message}`);
    return { moved: 0, discarded_conflicts: 0 };
  }
}

function tableExists(name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

const fkTables = [
  ['campaign_leads', 'lead_id'],
  ['sequence_enrollments', 'lead_id'],
  ['activities', 'lead_id'],
  ['messages', 'lead_id'],
  ['drafts', 'lead_id'],
  ['appointments', 'lead_id'],
];

const tx = db.transaction(() => {
  let collapsed = 0;
  for (const { userId, key, rows } of dupGroups) {
    const canonical = rows[0];
    const toKill = rows.slice(1);
    for (const k of toKill) {
      for (const [table, col] of fkTables) {
        if (!tableExists(table)) continue;
        const r = remap(table, col, k.id, canonical.id);
        if (r.moved || r.discarded_conflicts) {
          console.log(`  ${table}.${col}: moved=${r.moved} discarded=${r.discarded_conflicts} (id ${k.id} → ${canonical.id})`);
        }
      }
      db.prepare('DELETE FROM leads WHERE id = ?').run(k.id);
      console.log(`  deleted lead ${k.id}`);
      collapsed++;
    }
  }
  console.log(`\nTotal rows collapsed: ${collapsed}`);
});
tx();
console.log('Done.');
