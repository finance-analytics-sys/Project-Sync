/**
 * Reverse geocoding service using HERE Geocoding & Search API.
 *
 * Converts GPS coordinates (lat/lng) into a human-readable street address.
 * Uses a simple in-memory cache to avoid duplicate API calls for the same
 * location (employees often clock in from the same spot).
 *
 * Requires env var: HERE_API_KEY
 *
 * Free tier: 30,000 requests/month (more than enough for 38 employees).
 */
const https = require('https');

const HERE_API_KEY = process.env.HERE_API_KEY || '';

// ── In-memory cache ──
// Key: rounded lat,lng (5 decimal places ≈ 1.1m precision)
// Value: { address, timestamp }
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 500;

/**
 * Round coordinates to 5 decimal places for cache key.
 * 5 decimals ≈ 1.1 meter precision — good enough for address lookup.
 */
function cacheKey(lat, lng) {
  return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
}

/**
 * Evict expired entries from cache.
 */
function pruneCache() {
  if (cache.size <= MAX_CACHE_SIZE) return;
  const now = Date.now();
  for (const [key, val] of cache) {
    if (now - val.timestamp > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
  // If still over limit, drop oldest entries
  if (cache.size > MAX_CACHE_SIZE) {
    const entries = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.slice(0, cache.size - MAX_CACHE_SIZE);
    toRemove.forEach(([k]) => cache.delete(k));
  }
}

/**
 * Reverse geocode lat/lng to a street address using HERE API.
 * Returns the address string, or null on failure.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<string|null>} Street address or null
 */
async function reverseGeocode(latitude, longitude) {
  if (!HERE_API_KEY) {
    console.warn('[Geocode] No HERE_API_KEY configured — skipping reverse geocode');
    return null;
  }

  if (latitude == null || longitude == null) return null;

  // Check cache first
  const key = cacheKey(latitude, longitude);
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    console.log(`[Geocode] Cache hit: ${cached.address}`);
    return cached.address;
  }

  return new Promise((resolve) => {
    const path = `/v1/revgeocode?at=${latitude},${longitude}&lang=en-US&apiKey=${HERE_API_KEY}`;

    const req = https.request({
      hostname: 'revgeocode.search.hereapi.com',
      path,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);

          if (res.statusCode !== 200) {
            console.error(`[Geocode] HERE API ${res.statusCode}:`, data.title || body);
            resolve(null);
            return;
          }

          if (data.items && data.items.length > 0) {
            const item = data.items[0];
            const address = item.address?.label || null;

            if (address) {
              // Cache the result
              pruneCache();
              cache.set(key, { address, timestamp: Date.now() });
              console.log(`[Geocode] Resolved: ${address}`);
            }

            resolve(address);
          } else {
            console.warn('[Geocode] No results for coordinates:', latitude, longitude);
            resolve(null);
          }
        } catch (e) {
          console.error('[Geocode] Parse error:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Geocode] Request error:', e.message);
      resolve(null);
    });

    // 5 second timeout
    req.setTimeout(5000, () => {
      console.warn('[Geocode] Request timed out');
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

/**
 * Check if HERE geocoding is configured.
 */
function isConfigured() {
  return !!HERE_API_KEY;
}

module.exports = { reverseGeocode, isConfigured };
