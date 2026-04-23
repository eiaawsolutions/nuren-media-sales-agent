/**
 * Deterministic filename-based tagger.
 * The 27 Nuren decks follow predictable naming — we do NOT ask the LLM to
 * classify brand / asset_type from the filename (that would be a waste of
 * tokens AND a hallucination risk for something we can pattern-match).
 *
 * Only industry / objective / budget_tier are AI-inferred later, from the
 * actual slide content.
 */
export function tagFromFilename(filename) {
  const n = filename.toLowerCase();

  // --- brand ---
  let brand = 'cross';
  if (/(mmy|motherhood\s*malaysia|motherhood\s*choice|parentcraft|super\s*kids|new\s*mom|market\s*research)/i.test(filename)
      && !/msg|singapore|kelab\s*mama|nuren\s*21|creator\s*food/i.test(filename)) brand = 'mmy';
  else if (/kmm|kelab\s*mama/i.test(filename)) brand = 'kmm';
  else if (/msg|motherhood\s*sg|singapore/i.test(filename)) brand = 'msg';
  else if (/nuren\s*21/i.test(filename)) brand = 'nuren21';
  else if (/ibuencer/i.test(filename)) brand = 'ibuencer';
  else if (/parentcraft/i.test(filename)) brand = 'parentcraft';

  // --- asset_type ---
  let asset_type = 'media_kit';
  if (/rate\s*card/i.test(filename)) asset_type = 'rate_card';
  else if (/survey|report|research/i.test(filename)) asset_type = 'survey';
  else if (/(sponsorship|workshop|pickleball|choice\s*awards|tiktok\s*live|short\s*drama|webinar|mysihat|expo|school\s*outreach|food\s*network)/i.test(filename)) asset_type = 'sponsorship';
  else if (/case\s*study/i.test(filename)) asset_type = 'case_study';
  else if (/media\s*kit|about\s*us/i.test(filename)) asset_type = 'media_kit';

  // --- objective heuristic (can be upgraded by content) ---
  let target_objective = 'any';
  if (/(awareness|brand|hero)/i.test(filename)) target_objective = 'awareness';
  else if (/(trial|sampling|consideration|webinar|workshop)/i.test(filename)) target_objective = 'consideration';
  else if (/(conversion|commerce|affiliate|shop)/i.test(filename)) target_objective = 'conversion';

  // --- industry heuristic (very rough, default 'any') ---
  const target_industry = 'any';

  // --- budget_tier heuristic (rate cards usually cover all tiers) ---
  const budget_tier = 'any';

  return { brand, asset_type, target_industry, target_objective, budget_tier };
}
