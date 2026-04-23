import { Router } from 'express';
import db from '../db/index.js';
import { funnel, funnelBySegment, abPerformance, topMessages, dailySeries, aiCostSummary } from '../services/analytics.js';

const router = Router();

// Superadmin can optionally see org-wide by passing ?all=1
function scopeUser(req) {
  if (req.user.role === 'superadmin' && req.query.all === '1') return null;
  return req.user.id;
}

router.get('/overview', (req, res) => {
  const userId = scopeUser(req);
  const f = funnel({ userId });
  const cost = aiCostSummary({ userId });
  const days = dailySeries({ userId, days: 14 });
  res.json({ funnel: f, daily: days, ai_cost: cost });
});

router.get('/funnel', (req, res) => {
  res.json(funnel({ userId: scopeUser(req), from: req.query.from, to: req.query.to }));
});

router.get('/by-segment', (req, res) => {
  res.json(funnelBySegment({ userId: scopeUser(req) }));
});

router.get('/ab', (req, res) => {
  res.json(abPerformance({ userId: scopeUser(req), campaignId: req.query.campaign_id ? parseInt(req.query.campaign_id, 10) : null }));
});

router.get('/top-messages', (req, res) => {
  res.json(topMessages({ userId: scopeUser(req), limit: Math.min(parseInt(req.query.limit || '10', 10), 50) }));
});

router.get('/daily', (req, res) => {
  res.json(dailySeries({ userId: scopeUser(req), days: Math.min(parseInt(req.query.days || '14', 10), 90) }));
});

router.get('/ai-cost', (req, res) => {
  res.json(aiCostSummary({ userId: scopeUser(req) }));
});

/**
 * Dashboard "today at a glance" — compact snapshot for the Dashboard view.
 */
router.get('/dashboard', (req, res) => {
  const userId = scopeUser(req);
  const f = funnel({ userId });
  const kb = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(slide_count),0) AS slides FROM kb_assets' + (userId ? '' : '')).get();
  const chunks = db.prepare('SELECT COUNT(*) c FROM kb_chunks').get();
  const draftsPending = db.prepare(`SELECT COUNT(*) c FROM messages m JOIN leads l ON l.id=m.lead_id WHERE m.status='drafted'${userId ? ' AND l.user_id = ?' : ''}`).get(...(userId ? [userId] : [])).c;
  const needsReview = db.prepare(`SELECT COUNT(*) c FROM messages m JOIN leads l ON l.id=m.lead_id WHERE m.classification='needs_review' AND m.status='drafted'${userId ? ' AND l.user_id = ?' : ''}`).get(...(userId ? [userId] : [])).c;
  const hotLeads = db.prepare(`SELECT COUNT(*) c FROM leads WHERE lead_type='hot' AND status NOT IN ('closed_won','closed_lost','unsubscribed','bounced')${userId ? ' AND user_id = ?' : ''}`).get(...(userId ? [userId] : [])).c;
  const upcoming = db.prepare(`SELECT COUNT(*) c FROM appointments WHERE scheduled_at >= datetime('now') AND status IN ('scheduled','confirmed')${userId ? ' AND user_id = ?' : ''}`).get(...(userId ? [userId] : [])).c;
  const activeCampaigns = db.prepare(`SELECT COUNT(*) c FROM campaigns WHERE status='active'${userId ? ' AND user_id = ?' : ''}`).get(...(userId ? [userId] : [])).c;
  res.json({
    funnel: f,
    kb: { assets: kb.c, slides: kb.slides, chunks: chunks.c },
    drafts_pending: draftsPending,
    needs_review: needsReview,
    hot_leads: hotLeads,
    upcoming_meetings: upcoming,
    active_campaigns: activeCampaigns,
  });
});

export default router;
