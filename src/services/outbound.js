import crypto from 'crypto';
import db from '../db/index.js';
import { sendEmail } from '../utils/email.js';
import { config } from '../config/index.js';

/**
 * Wrap a draft body with tracking pixel + rewrite URLs through our click redirector.
 * Strategy:
 *   - every plain-text line becomes <p>…</p> in HTML
 *   - every http(s) URL gets rewritten to /api/tracking/click/<token>?m=<msg_id>&u=<b64url>
 *   - an invisible <img src="/api/tracking/open/<token>?m=<msg_id>"> is appended at the end
 *
 * Requires `public_base_url` in settings (or PUBLIC_BASE_URL env) — in dev it defaults to http://localhost:3000.
 */
export async function sendOutbound(messageId, { userId }) {
  const msg = db.prepare(`
    SELECT m.*, l.email AS lead_email, l.name AS lead_name, l.user_id AS owner_id, l.status AS lead_status
    FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE m.id = ?
  `).get(messageId);
  if (!msg) throw new Error('message not found');
  if (msg.owner_id !== userId) throw new Error('not your lead');
  if (msg.status !== 'drafted' && msg.status !== 'queued') throw new Error(`message status is ${msg.status}, cannot send`);
  if (msg.channel !== 'email') throw new Error('sendOutbound currently supports email only');
  if (!msg.lead_email) throw new Error('lead has no email — cannot send');
  if (msg.lead_status === 'unsubscribed' || msg.lead_status === 'bounced') throw new Error(`lead is ${msg.lead_status}`);

  const baseUrl = publicBaseUrl();
  const trackingToken = crypto.randomBytes(12).toString('hex');
  db.prepare('UPDATE messages SET external_id = COALESCE(external_id, ?) WHERE id = ?').run('trk_' + trackingToken, messageId);

  const { html, hadLinks } = composeHtml({
    body: msg.body,
    trackingToken,
    messageId,
    baseUrl,
    fromName: db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get()?.value || 'Nuren Media',
    unsubscribeUrl: `${baseUrl}/unsubscribe?m=${messageId}&t=${trackingToken}`,
  });

  let result;
  try {
    result = await sendEmail({
      to: msg.lead_email,
      subject: msg.subject || '(no subject)',
      html,
      headers: {
        'List-Unsubscribe': `<${baseUrl}/unsubscribe?m=${messageId}&t=${trackingToken}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tags: [
        { name: 'message_id', value: String(messageId) },
        { name: 'step', value: String(msg.step_number || 0) },
        { name: 'variant', value: msg.variant_key || 'A' },
      ],
    });
  } catch (err) {
    db.prepare("UPDATE messages SET status = 'failed', error = ?, sent_at = datetime('now') WHERE id = ?").run(err.message, messageId);
    db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description) VALUES (?,?,?,?,?)")
      .run(userId, msg.lead_id, msg.campaign_id, 'email_sent', `Send FAILED to ${msg.lead_email}: ${err.message}`);
    throw err;
  }

  db.prepare("UPDATE messages SET status = 'sent', sent_at = datetime('now'), external_id = ?, error = NULL WHERE id = ?")
    .run(result.id || ('trk_' + trackingToken), messageId);
  db.prepare("UPDATE leads SET status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, updated_at = datetime('now') WHERE id = ?").run(msg.lead_id);
  db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description, meta) VALUES (?,?,?,?,?,?)")
    .run(userId, msg.lead_id, msg.campaign_id, 'email_sent', `Sent step ${msg.step_number || 0} to ${msg.lead_email}`, JSON.stringify({ resend_id: result.id, had_links: hadLinks }));

  return { success: true, resend_id: result.id, tracking_token: trackingToken };
}

function composeHtml({ body, trackingToken, messageId, baseUrl, fromName, unsubscribeUrl }) {
  const escaped = escHtml(body);
  const paras = escaped.split(/\n{2,}/).map(p => `<p style="margin:0 0 14px; line-height:1.55; color:#1b1147; font-family:'Helvetica Neue',Arial,sans-serif; font-size:15px">${p.replace(/\n/g, '<br>')}</p>`).join('\n');

  // Rewrite URLs through click redirector
  let hadLinks = false;
  const withLinks = paras.replace(/(https?:\/\/[^\s<"]+)/gi, (url) => {
    hadLinks = true;
    const encoded = Buffer.from(url, 'utf8').toString('base64url');
    return `<a href="${baseUrl}/api/tracking/click/${trackingToken}?m=${messageId}&u=${encoded}" style="color:#3b3064; text-decoration:underline">${url}</a>`;
  });

  const pixel = `<img src="${baseUrl}/api/tracking/open/${trackingToken}?m=${messageId}" alt="" width="1" height="1" style="display:block; border:0" />`;
  const footer = `<p style="font-size:11px; color:#7b708f; margin-top:28px; font-family:'Helvetica Neue',Arial,sans-serif">${escHtml(fromName)} · <a href="${unsubscribeUrl}" style="color:#7b708f">Unsubscribe</a></p>`;

  const html = `<!doctype html><html><body style="margin:0; background:#fff7ef; padding:24px">
<div style="max-width:560px; margin:0 auto; background:#ffffff; padding:28px; border-radius:14px; border:1px solid #e7dfd1">
${withLinks}
${footer}
</div>
${pixel}
</body></html>`;
  return { html, hadLinks };
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function publicBaseUrl() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'public_base_url'").get();
  return (row?.value || process.env.PUBLIC_BASE_URL || `http://localhost:${config.port}`).replace(/\/+$/, '');
}
