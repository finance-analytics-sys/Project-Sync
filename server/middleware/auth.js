/**
 * JWT authentication middleware.
 * Uses Node crypto HMAC as a lightweight JWT replacement (no external deps).
 * Swap for jsonwebtoken in production.
 */
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const TOKEN_EXPIRY_HOURS = 12;

// ── Lightweight JWT ──

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function createToken(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_HOURS * 3600,
  }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  const [header, body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  if (sig !== expected) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ── Middleware ──

function authenticate(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return verifyToken(authHeader.slice(7));
}

function requireAuth(req, res) {
  const user = authenticate(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return null;
  }
  return user;
}

function requireLevel(req, res, maxLevel) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.level > maxLevel) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Insufficient permissions' }));
    return null;
  }
  return user;
}

module.exports = { createToken, verifyToken, authenticate, requireAuth, requireLevel };
