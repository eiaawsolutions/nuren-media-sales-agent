import crypto from 'crypto';

/**
 * Generate a Google Meet "new meeting" link of the form xxx-xxxx-xxx.
 * Format that Google's UI accepts when the host opens the URL.
 */
export function generateMeetLink() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const pick = (n) => Array.from(crypto.randomBytes(n), b => chars[b % 26]).join('');
  return `https://meet.google.com/${pick(3)}-${pick(4)}-${pick(3)}`;
}

export function generateCallToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Build a minimal RFC 5545 .ics calendar event so Resend can attach it.
 * Most modern email clients (Gmail/Outlook/Apple Mail) render this as
 * "Add to Calendar" — no Google Calendar API needed.
 */
export function buildIcsEvent({ title, description, location, scheduledAt, durationMinutes, organizer, attendee }) {
  const dt = new Date(scheduledAt);
  const dtEnd = new Date(dt.getTime() + (durationMinutes || 30) * 60_000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const uid = crypto.randomBytes(8).toString('hex') + '@nurengroup.com';
  const escape = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nuren Group//Sales Agent//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(dt)}`,
    `DTEND:${fmt(dtEnd)}`,
    `SUMMARY:${escape(title)}`,
    description ? `DESCRIPTION:${escape(description)}` : null,
    location ? `LOCATION:${escape(location)}` : null,
    organizer ? `ORGANIZER;CN=${escape(organizer.name || 'Nuren Media')}:mailto:${organizer.email}` : null,
    attendee ? `ATTENDEE;CN=${escape(attendee.name || '')};RSVP=TRUE:mailto:${attendee.email}` : null,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return { content: lines.join('\r\n'), filename: 'invite.ics' };
}
