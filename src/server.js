import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';

import db from './db/index.js';
import { requireAuth } from './middleware/auth.js';
import authRouter from './routes/auth.js';
import settingsRouter from './routes/settings.js';
import knowledgeRouter from './routes/knowledge.js';
import leadsRouter from './routes/leads.js';
import accountsRouter from './routes/accounts.js';
import draftsRouter from './routes/drafts.js';
import messagesRouter from './routes/messages.js';
import trackingRouter from './routes/tracking.js';
import campaignsRouter from './routes/campaigns.js';
import pipelineRouter from './routes/pipeline.js';
import appointmentsRouter, { lookupByCallToken } from './routes/appointments.js';
import analyticsRouter from './routes/analytics.js';
import { handleInboundReply } from './services/reply-handler.js';
import { startScheduler } from './services/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: config.allowedOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', 1);

app.use('/api', rateLimit({ windowMs: 60_000, max: 180, validate: false, message: { error: 'Too many requests. Slow down.' } }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 10, validate: false, message: { error: 'Too many login attempts. Try again in 15 minutes.' } }));

app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    const hasVec = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_chunks_vec'").get();
    res.json({ status: 'ok', vec: hasVec, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});



app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0, etag: true }));

// Tracking routes are public by design — open pixels, click redirects, and
// Resend webhook all run without auth. Mount BEFORE auth-protected routes.
app.use('/api/tracking', trackingRouter);

// Public unsubscribe URL (one-click RFC 8058 compliance)
app.get('/unsubscribe', (req, res) => res.redirect(302, '/api/tracking/unsubscribe-public?' + new URLSearchParams(req.query).toString()));
app.post('/unsubscribe', (req, res) => res.redirect(307, '/api/tracking/unsubscribe-public?' + new URLSearchParams(req.query).toString()));

app.use('/api/auth', authRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/knowledge', requireAuth, knowledgeRouter);
app.use('/api/leads', requireAuth, leadsRouter);
app.use('/api/accounts', requireAuth, accountsRouter);
app.use('/api/drafts', requireAuth, draftsRouter);
app.use('/api/messages', requireAuth, messagesRouter);
app.use('/api/campaigns', requireAuth, campaignsRouter);
app.use('/api/pipeline', requireAuth, pipelineRouter);
app.use('/api/appointments', requireAuth, appointmentsRouter);
app.use('/api/analytics', requireAuth, analyticsRouter);

// Public lookup for branded /call/:token landing — no auth, no PII leakage
app.get('/api/public/call/:token', (req, res) => {
  const a = lookupByCallToken(req.params.token);
  if (!a) return res.status(404).json({ error: 'Meeting not found' });
  // Strip lead_email — the page is shareable, don't echo PII back
  delete a.lead_email;
  delete a.host_email;
  res.json(a);
});
app.get('/call/:token', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'call.html')));

// Manual "mark replied" — used by the inbound test endpoint and by the SPA when a
// salesperson forwards a reply they got out of band
app.post('/api/inbound/mark-reply', requireAuth, async (req, res) => {
  const { lead_id, body, subject, external_id } = req.body || {};
  if (!lead_id || !body) return res.status(400).json({ error: 'lead_id + body required' });
  try {
    const r = await handleInboundReply({
      leadId: parseInt(lead_id, 10), bodyText: body, subject: subject || '', externalId: external_id || null, userId: req.user.id,
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/app', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));
app.get('/app/*', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'landing.html')));

app.use((err, req, res, next) => {
  // express.json() body parse failures → clean 400 (not a 500). Common on public
  // webhook endpoints where callers sometimes send empty/malformed bodies.
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid json body' });
  }
  console.error('Unhandled error:', err.message);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: err.message || 'Server error.' });
  next(err);
});

app.get('*', (_, res) => {
  const landing = path.join(__dirname, '..', 'public', 'landing.html');
  if (fs.existsSync(landing)) return res.sendFile(landing);
  res.status(404).send('Not found');
});

const PORT = process.env.PORT || config.port;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Nuren Media Sales Agent running on port ${PORT}`);
  // Disable scheduler in test/smoke runs by setting SCHEDULER_DISABLED=1
  if (process.env.SCHEDULER_DISABLED !== '1') startScheduler();
});
