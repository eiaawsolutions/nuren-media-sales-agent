import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initializeDatabase } from './schema.js';
import { config } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = config.dataDir || path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'agent.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

try {
  sqliteVec.load(db);
  const row = db.prepare('SELECT vec_version() AS v').get();
  console.log(`sqlite-vec loaded: ${row.v}`);
} catch (err) {
  console.error('Failed to load sqlite-vec — vector search disabled:', err.message);
}

initializeDatabase(db);

export default db;
