/**
 * Database layer using JSON file storage.
 * Drop-in replaceable with better-sqlite3 for production.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// DATA_DIR is configurable via env var for persistent storage (e.g. Render Disk)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Default empty database
const EMPTY_DB = {
  users: [],
  offices: [],
  clock_entries: [],
  pto_requests: [],
  holidays: [],
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) return JSON.parse(JSON.stringify(EMPTY_DB));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function save(db) {
  ensureDataDir();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function generateId() {
  return crypto.randomUUID();
}

// ── Helpers ──

function findAll(table, filterFn) {
  const db = load();
  const rows = db[table] || [];
  return filterFn ? rows.filter(filterFn) : rows;
}

function findOne(table, filterFn) {
  return findAll(table, filterFn)[0] || null;
}

function insert(table, record) {
  const db = load();
  if (!record.id) record.id = generateId();
  record.created_at = record.created_at || new Date().toISOString();
  record.updated_at = new Date().toISOString();
  db[table].push(record);
  save(db);
  return record;
}

function update(table, id, updates) {
  const db = load();
  const idx = db[table].findIndex((r) => r.id === id);
  if (idx === -1) return null;
  Object.assign(db[table][idx], updates, { updated_at: new Date().toISOString() });
  save(db);
  return db[table][idx];
}

function remove(table, id) {
  const db = load();
  const idx = db[table].findIndex((r) => r.id === id);
  if (idx === -1) return false;
  db[table].splice(idx, 1);
  save(db);
  return true;
}

function resetDb() {
  save(JSON.parse(JSON.stringify(EMPTY_DB)));
}

module.exports = {
  load, save, generateId,
  findAll, findOne, insert, update, remove,
  resetDb, DATA_DIR, DB_FILE,
};
