import nodemailer from 'nodemailer';
import db from '../db/index.js';
import { decrypt } from './crypto.js';
import { config } from '../config/index.js';

/**
 * Send an email using the best-available transport.
 *
 * Priority:
 *   1. Resend API if `resend_api_key` is set (in settings table or RESEND_API_KEY env).
 *      - Resend requires a verified sending domain. If FROM_EMAIL is on an
 *        unverified domain, Resend will 403 — we bubble the error so the
 *        operator sees it.
 *   2. SMTP fallback via nodemailer if `SMTP_USER` + `SMTP_HOST` are set
 *      (or settings.smtp_user/smtp_host). Uses the same `FROM_EMAIL` display.
 *
 * Matches the EIAAW Sales marketing agent pattern so the Gmail SMTP credentials
 * that EIAAW already uses can be reused verbatim for Nuren on day 1, with
 * Resend as a drop-in upgrade once the sending domain is DNS-verified.
 */
export async function sendEmail({ to, subject, html, from, attachments, icalEvent, replyTo, headers, tags }) {
  const resendKey = getSetting('resend_api_key', config.resendApiKey, { sensitive: true });
  const configuredFrom = from || getSetting('from_email', config.fromEmail);

  if (resendKey && resendKey.length > 5 && !resendKey.includes('•')) {
    return sendViaResend(resendKey, { to, subject, html, from: configuredFrom, attachments, icalEvent, replyTo, headers, tags });
  }
  return sendViaSmtp({ to, subject, html, from: configuredFrom, attachments, icalEvent, replyTo });
}

async function sendViaResend(apiKey, { to, subject, html, from, attachments, icalEvent, replyTo, headers, tags }) {
  const payload = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (replyTo) payload.reply_to = replyTo;
  if (tags) payload.tags = tags;
  if (headers) payload.headers = headers;

  const all = [];
  if (icalEvent?.content) all.push({ filename: icalEvent.filename || 'invite.ics', content: Buffer.from(icalEvent.content).toString('base64') });
  if (attachments?.length) all.push(...attachments);
  if (all.length) payload.attachments = all;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${data.message || JSON.stringify(data)}`);
  return { method: 'resend', id: data.id };
}

async function sendViaSmtp({ to, subject, html, from, attachments, icalEvent, replyTo }) {
  const host = getSetting('smtp_host', config.smtp.host);
  const port = parseInt(getSetting('smtp_port', String(config.smtp.port || 587)), 10);
  const user = getSetting('smtp_user', config.smtp.user);
  const pass = getSetting('smtp_pass', config.smtp.pass, { sensitive: true });
  if (!host || !user) throw new Error('No email transport configured. Set RESEND_API_KEY, or SMTP_HOST + SMTP_USER + SMTP_PASS.');

  const transporter = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });

  const mail = { from: from || user, to, subject, html };
  if (replyTo) mail.replyTo = replyTo;
  if (icalEvent) mail.icalEvent = icalEvent;
  if (attachments) mail.attachments = attachments;

  const info = await transporter.sendMail(mail);
  return { method: 'smtp', id: info.messageId };
}

function getSetting(key, fallback, { sensitive = false } = {}) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const raw = row?.value;
  if (raw) return sensitive ? decrypt(raw) : raw;
  return fallback || '';
}
