import { Router } from 'express';
import db from '../db/index.js';
import { generateMeetLink, generateCallToken, buildIcsEvent } from '../services/appointments.js';
import { sendEmail } from '../utils/email.js';
import { config } from '../config/index.js';

const router = Router();

router.get('/', (req, res) => {
  const { upcoming, status } = req.query;
  const where = ['a.user_id = ?'];
  const params = [req.user.id];
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (upcoming === '1') where.push("a.scheduled_at >= datetime('now') AND a.status IN ('scheduled','confirmed')");
  const rows = db.prepare(`
    SELECT a.*, l.name AS lead_name, l.email AS lead_email, l.company_website,
           ac.name AS account_name
    FROM appointments a
    LEFT JOIN leads l ON l.id = a.lead_id
    LEFT JOIN accounts ac ON ac.id = l.account_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.scheduled_at ASC
  `).all(...params);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const a = db.prepare(`
    SELECT a.*, l.name AS lead_name, l.email AS lead_email FROM appointments a
    LEFT JOIN leads l ON l.id = a.lead_id WHERE a.id = ? AND a.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});

router.post('/', async (req, res) => {
  const { lead_id, title, scheduled_at, duration_minutes = 30, type = 'discovery', notes, location } = req.body || {};
  if (!title || !scheduled_at) return res.status(400).json({ error: 'title + scheduled_at required' });

  const meet_link = location || generateMeetLink();
  const call_token = generateCallToken();

  const r = db.prepare(
    "INSERT INTO appointments (user_id, lead_id, title, scheduled_at, duration_minutes, type, notes, meet_link, call_token) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(req.user.id, lead_id || null, title, scheduled_at, duration_minutes, type, notes || null, meet_link, call_token);
  const id = Number(r.lastInsertRowid);

  if (lead_id) {
    db.prepare("INSERT INTO activities (user_id, lead_id, type, description, meta) VALUES (?,?,?,?,?)")
      .run(req.user.id, lead_id, 'meeting_booked', `Meeting booked: ${title} at ${new Date(scheduled_at).toLocaleString()}`, JSON.stringify({ meet_link, appointment_id: id }));
    // Auto-send invite email if lead has an email
    const lead = db.prepare('SELECT name, email FROM leads WHERE id = ?').get(lead_id);
    if (lead?.email) {
      sendInviteEmail({ apptId: id, lead, title, scheduledAt: new Date(scheduled_at), durationMinutes: duration_minutes, meetLink: meet_link, callToken: call_token, notes, type, fromEmail: req.user.email })
        .catch(err => console.error('[appt] invite email failed:', err.message));
    }
  }
  res.json({ id, meet_link, call_token });
});

router.patch('/:id', (req, res) => {
  const allowed = ['title', 'scheduled_at', 'duration_minutes', 'status', 'type', 'notes'];
  const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const sets = fields.map(f => `${f} = ?`).join(', ');
  const params = fields.map(f => req.body[f]);
  params.push(req.params.id, req.user.id);
  db.prepare(`UPDATE appointments SET ${sets}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(...params);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM appointments WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ deleted: r.changes });
});

/** Public lookup by call_token — used by the branded /call/:token landing */
export function lookupByCallToken(token) {
  return db.prepare(`
    SELECT a.id, a.title, a.scheduled_at, a.duration_minutes, a.status, a.type, a.notes, a.meet_link, a.call_token,
           l.name AS lead_name, l.email AS lead_email,
           u.display_name AS host_name, u.email AS host_email
    FROM appointments a
    LEFT JOIN leads l ON l.id = a.lead_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.call_token = ?
  `).get(token);
}

async function sendInviteEmail({ apptId, lead, title, scheduledAt, durationMinutes, meetLink, callToken, notes, type, fromEmail }) {
  const baseUrl = (db.prepare("SELECT value FROM settings WHERE key = 'public_base_url'").get()?.value || process.env.PUBLIC_BASE_URL || `http://localhost:${config.port}`).replace(/\/+$/, '');
  const callPage = `${baseUrl}/call/${callToken}`;
  const dateStr = scheduledAt.toLocaleString('en-MY', { dateStyle: 'full', timeStyle: 'short' });
  const ics = buildIcsEvent({
    title, description: `${notes || ''}\n\nJoin: ${meetLink}\nMeeting page: ${callPage}`,
    location: meetLink, scheduledAt, durationMinutes,
    organizer: { name: 'Nuren Media', email: fromEmail || 'sales@nurengroup.com' },
    attendee: { name: lead.name, email: lead.email },
  });
  const html = `<!doctype html><html><body style="margin:0;background:#fff7ef;padding:24px;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;padding:28px;border-radius:14px;border:1px solid #e7dfd1">
  <h2 style="margin:0 0 12px;color:#1b1147">${escHtml(title)}</h2>
  <p style="margin:0 0 8px;color:#1b1147"><strong>${escHtml(dateStr)}</strong> · ${durationMinutes} min · ${type}</p>
  ${notes ? `<p style="color:#3b3064;line-height:1.55">${escHtml(notes)}</p>` : ''}
  <p style="margin:18px 0 6px"><a href="${meetLink}" style="display:inline-block;background:#1b1147;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600">Join Google Meet</a></p>
  <p style="font-size:12.5px;color:#7b708f">Or visit your branded meeting page: <a href="${callPage}" style="color:#3b3064">${escHtml(callPage)}</a></p>
  <p style="font-size:11px;color:#7b708f;margin-top:24px">Nuren Media · sales@nurengroup.com</p>
</div></body></html>`;
  return sendEmail({
    to: lead.email,
    subject: `Calendar invite — ${title}`,
    html, icalEvent: ics,
    headers: { 'X-Appointment-Id': String(apptId) },
  });
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export default router;
