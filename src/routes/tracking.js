import { Router } from 'express';
import db from '../db/index.js';

const router = Router();

// 1x1 transparent GIF bytes
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * GET /api/tracking/open/:token?m=<message_id>
 * Logs an open event + updates messages.opened_at (first open wins), then
 * returns a 1x1 gif. Never 4xx — always return the pixel so inbox rendering isn't broken.
 */
router.get('/open/:token', (req, res) => {
  const messageId = parseInt(req.query.m, 10);
  if (messageId) {
    try {
      const msg = db.prepare('SELECT id, lead_id, campaign_id, opened_at, status FROM messages WHERE id = ?').get(messageId);
      if (msg && msg.status !== 'drafted') {
        if (!msg.opened_at) {
          db.prepare("UPDATE messages SET opened_at = datetime('now'), status = CASE WHEN status IN ('sent','delivered') THEN 'opened' ELSE status END WHERE id = ?").run(messageId);
          db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description) VALUES ((SELECT user_id FROM leads WHERE id = ?), ?, ?, 'email_opened', 'Lead opened email')")
            .run(msg.lead_id, msg.lead_id, msg.campaign_id);
        }
        db.prepare('INSERT INTO email_events (external_id, event_type, payload) VALUES (?, ?, ?)')
          .run('msg_' + messageId, 'opened', JSON.stringify({ ua: req.headers['user-agent'] || '', ip: req.ip }));
      }
    } catch (err) { console.error('[open]', err.message); }
  }
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(PIXEL);
});

/**
 * GET /api/tracking/click/:token?m=<message_id>&u=<base64url_target>
 * Logs a click event then redirects to the target URL.
 */
router.get('/click/:token', (req, res) => {
  const messageId = parseInt(req.query.m, 10);
  let target;
  try {
    target = Buffer.from(String(req.query.u || ''), 'base64url').toString('utf8');
  } catch { return res.status(400).send('invalid redirect'); }
  if (!/^https?:\/\//i.test(target)) return res.status(400).send('invalid redirect');

  if (messageId) {
    try {
      const msg = db.prepare('SELECT id, lead_id, campaign_id, clicked_at FROM messages WHERE id = ?').get(messageId);
      if (msg) {
        if (!msg.clicked_at) {
          db.prepare("UPDATE messages SET clicked_at = datetime('now'), status = 'clicked' WHERE id = ?").run(messageId);
          db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description, meta) VALUES ((SELECT user_id FROM leads WHERE id = ?), ?, ?, 'email_clicked', 'Lead clicked link', ?)")
            .run(msg.lead_id, msg.lead_id, msg.campaign_id, JSON.stringify({ target }));
        }
        db.prepare('INSERT INTO email_events (external_id, event_type, payload) VALUES (?,?,?)')
          .run('msg_' + messageId, 'clicked', JSON.stringify({ target, ua: req.headers['user-agent'] || '' }));
      }
    } catch (err) { console.error('[click]', err.message); }
  }
  res.redirect(302, target);
});

/**
 * Resend webhook receiver. Resend signs webhook payloads with svix signatures.
 * For MVP we accept any POST and validate message_id in the payload; add
 * svix signature verification before production (Resend docs: svix-signature header).
 */
router.post('/webhook/resend', (req, res) => {
  try {
    const evt = req.body || {};
    const type = evt.type || '';
    const data = evt.data || {};
    const msgIdTag = (data.tags || []).find(t => t.name === 'message_id');
    const messageId = msgIdTag ? parseInt(msgIdTag.value, 10) : null;
    const extId = data.email_id || data.id || '';

    db.prepare('INSERT INTO email_events (external_id, event_type, payload) VALUES (?,?,?)')
      .run(extId || ('msg_' + messageId), type, JSON.stringify(evt));

    if (messageId) {
      // Map Resend event types to our status enum
      const map = {
        'email.sent': 'sent',
        'email.delivered': 'delivered',
        'email.opened': 'opened',
        'email.clicked': 'clicked',
        'email.bounced': 'bounced',
        'email.complained': 'bounced',
      };
      const newStatus = map[type];
      if (newStatus === 'delivered') db.prepare("UPDATE messages SET status = CASE WHEN status IN ('sent') THEN 'delivered' ELSE status END WHERE id = ?").run(messageId);
      if (newStatus === 'opened') db.prepare("UPDATE messages SET opened_at = COALESCE(opened_at, datetime('now')), status = CASE WHEN status IN ('sent','delivered') THEN 'opened' ELSE status END WHERE id = ?").run(messageId);
      if (newStatus === 'clicked') db.prepare("UPDATE messages SET clicked_at = COALESCE(clicked_at, datetime('now')), status = 'clicked' WHERE id = ?").run(messageId);
      if (newStatus === 'bounced') {
        db.prepare("UPDATE messages SET status = 'bounced' WHERE id = ?").run(messageId);
        const msg = db.prepare('SELECT lead_id FROM messages WHERE id = ?').get(messageId);
        if (msg?.lead_id) db.prepare("UPDATE leads SET status = 'bounced' WHERE id = ?").run(msg.lead_id);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[resend webhook]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Public unsubscribe — 1-click list-unsubscribe compliance */
router.get('/unsubscribe-public', (req, res) => {
  const messageId = parseInt(req.query.m, 10);
  const token = req.query.t;
  if (messageId && token) unsubscribeByToken(messageId, token);
  res.set('Content-Type', 'text/html').send(`<!doctype html><html><body style="font-family:system-ui; padding:48px; text-align:center; color:#1b1147">
<h1 style="font-weight:700">You're unsubscribed.</h1>
<p>You won't hear from Nuren Media again. If this was a mistake, email sales@nurengroup.com.</p>
</body></html>`);
});

router.post('/unsubscribe-public', (req, res) => {
  const messageId = parseInt(req.query.m || req.body?.m, 10);
  const token = req.query.t || req.body?.t;
  if (messageId && token) unsubscribeByToken(messageId, token);
  res.json({ unsubscribed: true });
});

function unsubscribeByToken(messageId, token) {
  try {
    const msg = db.prepare('SELECT id, lead_id, external_id FROM messages WHERE id = ?').get(messageId);
    if (!msg) return;
    if (!String(msg.external_id || '').includes(token)) return;
    db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(msg.lead_id);
    db.prepare("UPDATE sequence_enrollments SET status = 'unsubscribed', paused_reason = 'unsubscribed', last_action_at = datetime('now') WHERE lead_id = ? AND status IN ('pending','running')").run(msg.lead_id);
    db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description) VALUES ((SELECT user_id FROM leads WHERE id = ?), ?, NULL, 'unsubscribe', 'Lead unsubscribed via 1-click link')").run(msg.lead_id, msg.lead_id);
    db.prepare('INSERT INTO email_events (external_id, event_type, payload) VALUES (?,?,?)').run('msg_' + messageId, 'unsubscribed', JSON.stringify({ via: 'one-click' }));
  } catch (err) { console.error('[unsubscribe]', err.message); }
}

export default router;
