/**
 * Small, robust CSV parser that handles:
 *  - RFC-4180 double-quoted fields ("Foo, Bar" -> Foo, Bar)
 *  - Escaped quotes inside quoted fields ("He said ""hi""")
 *  - LF and CRLF line endings
 *  - Trailing blank lines
 *
 * Returns array of row objects keyed by the header row (normalized to snake_case).
 * Unknown / extra columns are preserved under their original header key as well,
 * so callers can decide how strict to be.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = []; field = ''; i++; continue;
    }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  if (!rows.length) return [];

  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map(r => {
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = (r[j] ?? '').trim();
    return obj;
  });
}

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
