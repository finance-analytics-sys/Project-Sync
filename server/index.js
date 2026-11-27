/**
 * Project Sync — HTTP Server
 * Built with Node.js built-ins (no Express dependency).
 * Serves the API + static frontend files.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Load env from .env file if it exists
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

const { requireAuth, requireLevel } = require('./middleware/auth');
const { handleLogin, handleGoogleLogin, handleChangePassword, handleGetMe } = require('./routes/auth');
const { handleClockIn, handleClockOut, handleGetStatus, handleGetHistory, handleGetAllEntries, handleFlexClockIn, handleFlexClockOut, handleGetFlexBalance } = require('./routes/clock');
const { handleSubmit, handleApprove, handleDeny, handleCancel, handleEdit, handleGetMyRequests, handleGetPendingApprovals, handleGetAllRequests, handleGetCalendar, handleGetAllApproved, handleExecutiveCancel } = require('./routes/pto');
const { handleGetUsers, handleGetOffices, handleGetHolidays } = require('./routes/admin');
const { handleGetLogs } = require('./routes/logs');
const emailService = require('./services/email');

const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Parse request body ──
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ── Parse query string ──
function parseQuery(reqUrl) {
  const parsed = url.parse(reqUrl, true);
  return { pathname: parsed.pathname, query: parsed.query };
}

// ── CORS headers ──
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Send JSON response ──
function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── Static file serving ──
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveIndex(res) {
  const indexPath = path.join(__dirname, '..', 'client', 'public', 'index.html');
  if (!fs.existsSync(indexPath)) { res.writeHead(404); res.end('Not Found'); return; }

  let html = fs.readFileSync(indexPath, 'utf8');
  // Inject Google Client ID so the frontend can initialize GSI
  const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
  html = html.replace('</head>',
    `  <meta name="google-client-id" content="${googleClientId}">\n</head>`
  );
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  if (!fs.existsSync(filePath)) {
    // SPA fallback — serve index.html for non-API, non-file routes
    serveIndex(res);
    return;
  }

  // For index.html, inject Google Client ID
  if (filePath.endsWith('index.html')) {
    serveIndex(res);
    return;
  }

  res.writeHead(200, { 'Content-Type': mime });
  res.end(fs.readFileSync(filePath));
}

// ── Router ──
async function handleRequest(req, res) {
  setCors(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const { pathname, query } = parseQuery(req.url);

  // ── API Routes ──
  if (pathname.startsWith('/api/')) {
    try {
      let result;

      // ── Auth ──
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await parseBody(req);
        result = handleLogin(body);
      }
      else if (pathname === '/api/auth/google' && req.method === 'POST') {
        const body = await parseBody(req);
        result = await handleGoogleLogin(body);
      }
      else if (pathname === '/api/auth/me' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = handleGetMe(user);
      }
      else if (pathname === '/api/auth/change-password' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = handleChangePassword(body, user);
      }

      // ── Clock ──
      else if (pathname === '/api/clock/in' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = await handleClockIn(body, user);
      }
      else if (pathname === '/api/clock/out' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = await handleClockOut(body, user);
      }
      else if (pathname === '/api/clock/status' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = handleGetStatus(user);
      }
      else if (pathname === '/api/clock/history' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = handleGetHistory(user, query);
      }
      else if (pathname === '/api/clock/all' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = await handleGetAllEntries(user, query);
      }

      // ── Flex Clock ──
      else if (pathname === '/api/clock/flex-in' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = await handleFlexClockIn(body, user);
      }
      else if (pathname === '/api/clock/flex-out' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = await handleFlexClockOut(body, user);
      }
      else if (pathname === '/api/clock/flex-balance' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = handleGetFlexBalance(user);
      }

      // ── PTO ──
      else if (pathname === '/api/pto/submit' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = await handleSubmit(body, user);
      }
      else if (pathname === '/api/pto/approve' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = await handleApprove(body, user);
      }
      else if (pathname === '/api/pto/deny' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = await handleDeny(body, user);
      }
      else if (pathname === '/api/pto/cancel' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = await handleCancel(body, user);
      }
      else if (pathname === '/api/pto/edit' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = await handleEdit(body, user);
      }
      else if (pathname === '/api/pto/my-requests' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = handleGetMyRequests(user);
      }
      else if (pathname === '/api/pto/pending' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = handleGetPendingApprovals(user);
      }
      else if (pathname === '/api/pto/all' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = handleGetAllRequests(user, query);
      }
      else if (pathname === '/api/pto/calendar' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = handleGetCalendar(user, query);
      }

      else if (pathname === '/api/pto/all-approved' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = handleGetAllApproved(user);
      }

      // ── PTO Executive Cancel ──
      else if (pathname === '/api/pto/executive-cancel' && req.method === 'POST') {
        const user = requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        result = await handleExecutiveCancel(body, user);
      }

      // ── Logs ──
      else if (pathname === '/api/logs' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = await handleGetLogs(user, query);
      }

      // ── Admin ──
      else if (pathname === '/api/admin/users' && req.method === 'GET') {
        const user = requireAuth(req, res);
        if (!user) return;
        result = handleGetUsers(user);
      }
      else if (pathname === '/api/admin/offices' && req.method === 'GET') {
        result = handleGetOffices();
      }
      else if (pathname === '/api/admin/holidays' && req.method === 'GET') {
        result = handleGetHolidays();
      }

      // ── 404 ──
      else {
        result = { status: 404, body: { error: 'Not found' } };
      }

      if (result) sendJson(res, result.status, result.body);

    } catch (err) {
      console.error('[Server Error]', err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
    return;
  }

  // ── Static files ──
  const staticBase = path.join(__dirname, '..', 'client', 'public');
  let filePath = path.join(staticBase, pathname === '/' ? 'index.html' : pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(staticBase)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  serveStatic(res, filePath);
}

// ── Start ──
emailService.init();

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`\n  Project Sync running at http://localhost:${PORT}\n`);
  console.log('  API endpoints:');
  console.log('    POST /api/auth/login');
  console.log('    GET  /api/auth/me');
  console.log('    POST /api/clock/in');
  console.log('    POST /api/clock/out');
  console.log('    GET  /api/clock/status');
  console.log('    POST /api/pto/submit');
  console.log('    POST /api/pto/approve');
  console.log('    POST /api/pto/deny');
  console.log('    GET  /api/pto/pending');
  console.log('    GET  /api/pto/my-requests');
  console.log('');
});
