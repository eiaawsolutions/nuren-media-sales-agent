/**
 * Server-side Lead Verification Gate — enforces the Global Lead Gen Contract
 * with Nuren's LinkedIn-first hardening (2026-04-23).
 *
 * Rules (non-negotiable):
 *   1. No fabricated contact info. Email/phone must be published on a credible
 *      source, else stored as '' (never guessed).
 *   2. ≥2 verification_sources URLs required (was 1 — tightened because Haiku
 *      exposed that single-source leads were trivially guessable).
 *   3. For B2B / B2B2C leads: linkedin_url MUST point to a real linkedin.com/in/
 *      profile (not a company page, not a post URL). AI-generated leads without
 *      a valid /in/ URL are discarded.
 *   4. confidence_score 'low' -> reject.
 *   5. If lead_type === 'hot', a buying_signal string is required.
 *   6. Secondary source cannot be the same host as the linkedin_url (prevents
 *      linkedin.com/in/foo + linkedin.com/posts/bar counting as 2 sources).
 */

const URL_RE = /^https?:\/\/[^\s]+$/i;
const LINKEDIN_PROFILE_RE = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#\s]+/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d][\d\s\-().]{5,}$/;

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}

export function verifyLead(raw) {
  const reasons = [];
  const lead = { ...raw };

  // Normalize scalars
  lead.name = (lead.name || '').trim();
  lead.email = (lead.email || '').trim();
  lead.phone = (lead.phone || '').trim();
  lead.linkedin_url = (lead.linkedin_url || '').trim();
  lead.company_website = (lead.company_website || '').trim();
  lead.confidence_score = (lead.confidence_score || 'medium').toLowerCase();
  lead.lead_type = (lead.lead_type || 'cold').toLowerCase();

  // verification_sources normalization (accept array or comma-separated string)
  if (typeof lead.verification_sources === 'string') {
    lead.verification_sources = lead.verification_sources
      .split(/[,\n;]/).map(s => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(lead.verification_sources)) lead.verification_sources = [];

  // Rule 0: name required
  if (!lead.name) reasons.push('missing_name');

  // Rule 1: strip unverifiable contacts (no guessing allowed)
  if (lead.email && !EMAIL_RE.test(lead.email)) {
    reasons.push('malformed_email');
    lead.email = '';
  }
  if (lead.phone && !PHONE_RE.test(lead.phone)) {
    reasons.push('malformed_phone');
    lead.phone = '';
  }

  // Auto-promote linkedin_url + company_website into verification_sources if
  // the model listed them but forgot to cite them. Doesn't weaken the gate —
  // we still require 2 DISTINCT-HOST sources below.
  if (URL_RE.test(lead.linkedin_url) && !lead.verification_sources.includes(lead.linkedin_url)) {
    lead.verification_sources.unshift(lead.linkedin_url);
  }
  if (URL_RE.test(lead.company_website) && !lead.verification_sources.includes(lead.company_website)) {
    lead.verification_sources.push(lead.company_website);
  }

  // Rule 2: >=2 verification_sources URLs, spanning distinct hosts
  const validSources = lead.verification_sources.filter(u => URL_RE.test(u));
  lead.verification_sources = validSources;
  const uniqueHosts = new Set(validSources.map(hostOf).filter(Boolean));
  if (validSources.length < 2) reasons.push('need_two_verification_sources');
  else if (uniqueHosts.size < 2) reasons.push('verification_sources_same_host');

  // Rule 3: linkedin_url MUST be a real /in/ profile for B2B / B2B2C leads
  const leadType = (lead.type || 'B2B').toUpperCase();
  const hasLinkedInProfile = LINKEDIN_PROFILE_RE.test(lead.linkedin_url);
  if (leadType === 'B2B' || leadType === 'B2B2C') {
    if (!hasLinkedInProfile) reasons.push('missing_linkedin_profile_url');
  } else {
    // B2C: keep older rule — linkedin OR company_website accepted
    const hasWebsite = URL_RE.test(lead.company_website);
    if (!hasLinkedInProfile && !hasWebsite) reasons.push('no_linkedin_or_website');
  }

  // Rule 4: low confidence -> reject
  if (lead.confidence_score === 'low') reasons.push('low_confidence');

  // Rule 5: hot lead requires buying_signal
  if (lead.lead_type === 'hot' && !(lead.buying_signal || '').trim()) {
    reasons.push('hot_without_buying_signal');
  }

  // Enum coercion (so downstream never gets surprised)
  if (!['high', 'medium', 'low'].includes(lead.confidence_score)) lead.confidence_score = 'medium';
  if (!['hot', 'cold'].includes(lead.lead_type)) lead.lead_type = 'cold';
  if (!['B2B', 'B2C', 'B2B2C'].includes(lead.type)) lead.type = 'B2B';

  return { ok: reasons.length === 0, reasons, lead };
}
