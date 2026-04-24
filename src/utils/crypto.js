import crypto from 'crypto';
import { config } from '../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const ENCODING = 'base64';
const PREFIX = 'enc:';

export const SENSITIVE_KEYS = [
  'api_key',
  'resend_api_key',
  'voyage_api_key',
  'apollo_api_key',
  'smtp_pass',
  'linkedin_cookie',
  'meta_access_token',
  'shopee_cookie',
  'lazada_cookie',
];

function getEncryptionKey() {
  const key = config.encryptionKey;
  if (!key) return null;
  return crypto.createHash('sha256').update(key).digest();
}

export function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getEncryptionKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString(ENCODING);
}

export function decrypt(value) {
  if (!value) return value;
  if (!value.startsWith(PREFIX)) return value;
  const key = getEncryptionKey();
  if (!key) return value;
  try {
    const packed = Buffer.from(value.slice(PREFIX.length), ENCODING);
    const iv = packed.subarray(0, IV_LENGTH);
    const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return value;
  }
}

export function isSensitive(key) {
  return SENSITIVE_KEYS.includes(key);
}
