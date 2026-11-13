/**
 * Production startup script.
 * Seeds the database only if it doesn't exist yet (first deploy),
 * then starts the server.
 */
const fs = require('fs');
const path = require('path');

// Load env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valParts] = trimmed.split('=');
      process.env[key.trim()] = valParts.join('=').trim();
    }
  });
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[Start] Created data directory: ${DATA_DIR}`);
}

// Seed only if database doesn't exist or FORCE_SEED is set
if (!fs.existsSync(DB_FILE) || process.env.FORCE_SEED === 'true') {
  console.log('[Start] Database not found — running seed...');
  require('./seed');
  console.log('[Start] Seed complete.');
} else {
  console.log(`[Start] Database found at ${DB_FILE} — skipping seed.`);
}

// Start the server
require('./index');
