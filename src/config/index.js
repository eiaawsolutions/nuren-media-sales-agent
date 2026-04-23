import 'dotenv/config';

export const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  resendApiKey: process.env.RESEND_API_KEY,
  encryptionKey: process.env.ENCRYPTION_KEY,
  fromEmail: process.env.FROM_EMAIL || 'Nuren Media <sales@nurengroup.com>',
  kbSourceDir: process.env.KB_SOURCE_DIR || '',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim()).filter(Boolean),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  // Persist paths — on Railway, a volume is mounted at /app/data and we keep
  // both the SQLite DB and uploaded PPTXs under it so neither is wiped on redeploy.
  dataDir: process.env.DATA_DIR || '',       // absolute path override, e.g. /app/data
  kbDir: process.env.KB_DIR || '',           // absolute path override, e.g. /app/data/knowledge-base
};
