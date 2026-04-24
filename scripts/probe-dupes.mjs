import db from '../src/db/index.js';

// Measure actual duplicate patterns across the leads table.

console.log('=== duplicate by LinkedIn handle ===');
const dupLinkedIn = db.prepare(`
  SELECT lower(substr(linkedin_url, instr(linkedin_url, '/in/') + 4)) AS handle,
         COUNT(*) AS n,
         GROUP_CONCAT(id) AS ids,
         GROUP_CONCAT(name, ' | ') AS names
  FROM leads
  WHERE user_id = 1 AND linkedin_url LIKE '%/in/%'
  GROUP BY handle
  HAVING n > 1
  ORDER BY n DESC
`).all();
for (const r of dupLinkedIn) console.log(`  handle=${r.handle} x${r.n} ids=${r.ids}  names=${r.names}`);
if (dupLinkedIn.length === 0) console.log('  (none)');

console.log('\n=== duplicate by email ===');
const dupEmail = db.prepare(`
  SELECT lower(email) AS em, COUNT(*) AS n, GROUP_CONCAT(id) AS ids, GROUP_CONCAT(name, ' | ') AS names
  FROM leads
  WHERE user_id = 1 AND email != ''
  GROUP BY em
  HAVING n > 1
  ORDER BY n DESC
`).all();
for (const r of dupEmail) console.log(`  email=${r.em} x${r.n} ids=${r.ids}  names=${r.names}`);
if (dupEmail.length === 0) console.log('  (none)');

console.log('\n=== duplicate by name+company (case-insensitive) ===');
const dupName = db.prepare(`
  SELECT l.name, a.name AS company, COUNT(*) AS n, GROUP_CONCAT(l.id) AS ids, GROUP_CONCAT(l.email, ' | ') AS emails
  FROM leads l LEFT JOIN accounts a ON a.id = l.account_id
  WHERE l.user_id = 1
  GROUP BY lower(l.name), lower(COALESCE(a.name, ''))
  HAVING n > 1
  ORDER BY n DESC
`).all();
for (const r of dupName) console.log(`  ${r.name} @ ${r.company || '(no company)'} x${r.n} ids=${r.ids}  emails=${r.emails}`);
if (dupName.length === 0) console.log('  (none)');

console.log('\n=== duplicate by apollo_id (in enrichment JSON) ===');
// Pull all leads with enrichment.apollo_id, bucket in JS
const apolloLeads = db.prepare(`SELECT id, name, email, enrichment FROM leads WHERE user_id = 1 AND enrichment IS NOT NULL`).all();
const byApolloId = new Map();
for (const row of apolloLeads) {
  try {
    const aid = JSON.parse(row.enrichment)?.apollo_id;
    if (!aid) continue;
    if (!byApolloId.has(aid)) byApolloId.set(aid, []);
    byApolloId.get(aid).push(row);
  } catch {}
}
let apolloDupCount = 0;
for (const [aid, rows] of byApolloId) {
  if (rows.length > 1) {
    apolloDupCount++;
    console.log(`  apollo_id=${aid} x${rows.length} ids=${rows.map(r => r.id).join(',')} | ${rows.map(r => r.name + (r.email ? ':'+r.email : ':(no email)')).join(' | ')}`);
  }
}
if (apolloDupCount === 0) console.log('  (none)');

console.log('\n=== totals ===');
const total = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE user_id = 1').get();
console.log(`  ${total.n} total leads on user 1`);
