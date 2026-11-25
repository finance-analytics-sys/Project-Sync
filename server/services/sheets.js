/**
 * Google Sheets integration — zero-dependency, uses Node built-in https module.
 *
 * Writes timecard entries and approved PTOs to the shared Google Spreadsheet.
 *
 * Spreadsheet ID: 1ftgE58jBqGoMgWa2jVniGXzEkkoBQHA7cR0n77Hqo_Q
 *
 * Timecard tab columns: Name | Office | Clock in Location | Clock in time | Clock out time | Hours | Job code | Comment
 * PTO tab columns:      Name | Office | PTO Date | Hours requested | Reason
 *
 * PTO tab: ONE row per request. Date range in single cell (e.g., "Nov 26 – Nov 29").
 *
 * Authentication uses a Google Service Account. The service account JSON key file
 * path should be set in env var GOOGLE_SERVICE_ACCOUNT_KEY_FILE, or the key JSON
 * can be set directly in GOOGLE_SERVICE_ACCOUNT_KEY.
 */
const https = require('https');
const crypto = require('crypto');

const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID || '1ftgE58jBqGoMgWa2jVniGXzEkkoBQHA7cR0n77Hqo_Q';
const TIMECARD_TAB = process.env.SHEETS_TIMECARD_TAB || 'Timecard';
const PTO_TAB = process.env.SHEETS_PTO_TAB || 'PTO';

let _serviceAccountKey = null;
let _accessToken = null;
let _tokenExpiry = 0;

// ── Service Account Auth ──

function loadServiceAccountKey() {
  if (_serviceAccountKey) return _serviceAccountKey;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      _serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      return _serviceAccountKey;
    } catch (e) {
      console.error('[Sheets] Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY:', e.message);
    }
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    try {
      const fs = require('fs');
      const raw = fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, 'utf8');
      _serviceAccountKey = JSON.parse(raw);
      return _serviceAccountKey;
    } catch (e) {
      console.error('[Sheets] Failed to read service account key file:', e.message);
    }
  }

  return null;
}

function base64url(data) {
  let b64;
  if (Buffer.isBuffer(data)) {
    b64 = data.toString('base64');
  } else {
    b64 = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry - 60000) {
    return _accessToken;
  }

  const key = loadServiceAccountKey();
  if (!key) {
    console.warn('[Sheets] No service account key configured — Sheets integration disabled');
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const signInput = base64url(header) + '.' + base64url(payload);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign.sign(key.private_key);
  const jwt = signInput + '.' + base64url(signature);

  return new Promise((resolve) => {
    const postData = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.access_token) {
            _accessToken = data.access_token;
            _tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
            resolve(_accessToken);
          } else {
            console.error('[Sheets] Token error:', data.error_description || body);
            resolve(null);
          }
        } catch (e) {
          console.error('[Sheets] Token parse error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { console.error('[Sheets] Token request error:', e.message); resolve(null); });
    req.write(postData);
    req.end();
  });
}

// ── Sheets API Helpers ──

function sheetsRequest(method, path, body) {
  return new Promise(async (resolve) => {
    const token = await getAccessToken();
    if (!token) {
      console.warn('[Sheets] Skipping write — no access token');
      return resolve({ error: 'No access token' });
    }

    const options = {
      hostname: 'sheets.googleapis.com',
      path: `/v4/spreadsheets/${SPREADSHEET_ID}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            console.error(`[Sheets] API ${res.statusCode}:`, parsed.error?.message || data);
            resolve({ error: parsed.error?.message || `HTTP ${res.statusCode}` });
          }
        } catch (e) {
          resolve({ error: `Parse error: ${e.message}` });
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Sheets] Request error:', e.message);
      resolve({ error: e.message });
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function appendRows(tab, rows) {
  const range = `${tab}!A:Z`;
  const result = await sheetsRequest('POST',
    `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { values: rows },
  );
  if (result.error) {
    console.error(`[Sheets] appendRows to ${tab} failed:`, result.error);
  } else {
    console.log(`[Sheets] Appended ${rows.length} row(s) to ${tab}`);
  }
  return result;
}

// ── Date Formatting ──

function formatDateTimeForSheet(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function formatDateForSheet(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateRangeForSheet(startDate, endDate) {
  if (startDate === endDate) return formatDateForSheet(startDate);
  return `${formatDateForSheet(startDate)} – ${formatDateForSheet(endDate)}`;
}

// ── Public API ──

/**
 * Write a clock-out entry to the Timecard tab.
 * Called when an employee clocks out (we have all the data at that point).
 *
 * Columns: Name | Office | Clock in Location | Clock in time | Clock out time | Hours | Job code | Comment
 */
async function writeTimecardEntry(entry, user, officeName) {
  const hours = entry.clock_in && entry.clock_out
    ? ((new Date(entry.clock_out) - new Date(entry.clock_in)) / 3600000).toFixed(2)
    : '';

  const row = [
    `${user.first_name} ${user.last_name}`,
    officeName || user.office_code || '',
    entry.clock_in_location || '',
    formatDateTimeForSheet(entry.clock_in),
    formatDateTimeForSheet(entry.clock_out),
    hours,
    entry.job_code || 'Regular',
    entry.comment || '',
  ];

  return appendRows(TIMECARD_TAB, [row]);
}

/**
 * Write an approved PTO to the PTO tab.
 * Called when a PTO request is fully approved.
 *
 * Columns: Name | Office | PTO Date | Hours requested | Reason
 * Date range: single cell, e.g. "Nov 26 – Nov 29"
 */
async function writeApprovedPTO(request, user, officeName) {
  const row = [
    `${user.first_name} ${user.last_name}`,
    officeName || user.office_code || '',
    formatDateRangeForSheet(request.start_date, request.end_date),
    request.pto_hours || '',
    request.reason || '',
  ];

  return appendRows(PTO_TAB, [row]);
}

/**
 * Auto-generate PTO timecard entries for full-day approved PTO.
 * When PTO is approved, this creates one Timecard row per PTO day
 * with Job Code "PTO" and the approved hours for that day.
 *
 * Employee does NOT clock in on PTO days — this is auto-generated.
 */
async function writePTOTimecardEntries(request, user, officeName) {
  const startDate = new Date(request.start_date + 'T00:00:00');
  const endDate = new Date(request.end_date + 'T00:00:00');
  const totalDays = Math.round((endDate - startDate) / 86400000) + 1;
  const hoursPerDay = totalDays > 0 ? (request.pto_hours / totalDays).toFixed(2) : 8;

  const rows = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    // Skip weekends
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const dateStr = current.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      rows.push([
        `${user.first_name} ${user.last_name}`,
        officeName || user.office_code || '',
        'PTO',                    // Clock in Location = "PTO"
        dateStr + ' 9:00 AM',     // Nominal start
        dateStr + ' 5:00 PM',     // Nominal end
        hoursPerDay,
        'PTO',                    // Job Code
        `Approved PTO: ${request.reason || 'Time off'}`,
      ]);
    }
    current.setDate(current.getDate() + 1);
  }

  if (rows.length > 0) {
    return appendRows(TIMECARD_TAB, rows);
  }
  return { skipped: true, reason: 'No weekdays in PTO range' };
}

/**
 * STUB: Auto-generate Holiday timecard entries.
 * When a company holiday is confirmed, this will create a Timecard row
 * for each employee with Job Code "Holiday" and standard hours.
 *
 * Not yet implemented — waiting for confirmed holiday list from executives.
 */
async function writeHolidayTimecardEntries(/* holidayDate, employees */) {
  // TODO: Implement once holiday list is confirmed
  // For each employee:
  //   row: [name, office, "Holiday", date 9AM, date 5PM, 8, "Holiday", holidayName]
  console.log('[Sheets] STUB: writeHolidayTimecardEntries not yet implemented');
  return { stub: true };
}

/**
 * Check if Sheets integration is configured and ready.
 */
function isConfigured() {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE);
}

module.exports = {
  writeTimecardEntry,
  writeApprovedPTO,
  writePTOTimecardEntries,
  writeHolidayTimecardEntries,
  isConfigured,
  // Exposed for testing
  getAccessToken,
  SPREADSHEET_ID,
};
