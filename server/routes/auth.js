/**
 * Auth routes: login (email/password + Google OAuth), change password, user info.
 */
const crypto = require('crypto');
const https = require('https');
const db = require('../db');
const { createToken } = require('../middleware/auth');

// Allowed Google OAuth domains
const ALLOWED_DOMAINS = ['ycvliving.com', 'visitingangels.com'];
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.scryptSync(plain, salt, 64).toString('hex');
  return attempt === hash;
}

function handleLogin(body) {
  const { email, password } = body;
  if (!email || !password) return { status: 400, body: { error: 'Email and password are required' } };

  const user = db.findOne('users', (u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return { status: 401, body: { error: 'Invalid email or password' } };

  if (!verifyPassword(password, user.password_hash)) {
    return { status: 401, body: { error: 'Invalid email or password' } };
  }

  const token = createToken({
    id: user.id,
    email: user.email,
    role: user.role,
    level: user.level,
    office_code: user.office_code,
    is_exempt: user.is_exempt,
  });

  return {
    status: 200,
    body: {
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
        level: user.level,
        office_code: user.office_code,
        is_exempt: user.is_exempt,
      },
    },
  };
}

function handleChangePassword(body, authUser) {
  const { current_password, new_password } = body;
  if (!current_password || !new_password) {
    return { status: 400, body: { error: 'Current and new password are required' } };
  }
  if (new_password.length < 8) {
    return { status: 400, body: { error: 'New password must be at least 8 characters' } };
  }

  const user = db.findOne('users', (u) => u.id === authUser.id);
  if (!verifyPassword(current_password, user.password_hash)) {
    return { status: 401, body: { error: 'Current password is incorrect' } };
  }

  db.update('users', user.id, { password_hash: hashPassword(new_password) });
  return { status: 200, body: { success: true, message: 'Password changed' } };
}

function handleGetMe(authUser) {
  const user = db.findOne('users', (u) => u.id === authUser.id);
  if (!user) return { status: 404, body: { error: 'User not found' } };

  const office = user.office_code
    ? db.findOne('offices', (o) => o.code === user.office_code)
    : null;

  return {
    status: 200,
    body: {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      role: user.role,
      level: user.level,
      office_code: user.office_code,
      office_name: office?.name || null,
      is_exempt: user.is_exempt,
    },
  };
}

// ── Google OAuth ──

/**
 * Verify a Google ID token by calling Google's tokeninfo endpoint.
 * Returns the decoded payload or null on failure.
 */
function verifyGoogleToken(idToken) {
  return new Promise((resolve) => {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          if (res.statusCode !== 200 || payload.error) {
            console.error('[Google Auth] Token verification failed:', payload.error_description || payload.error);
            return resolve(null);
          }
          // Verify audience matches our client ID
          if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) {
            console.error('[Google Auth] Token audience mismatch');
            return resolve(null);
          }
          resolve(payload);
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.error('[Google Auth] Verification request failed:', err.message);
      resolve(null);
    });
  });
}

async function handleGoogleLogin(body) {
  const { credential } = body;
  if (!credential) {
    return { status: 400, body: { error: 'Google credential is required' } };
  }

  const payload = await verifyGoogleToken(credential);
  if (!payload) {
    return { status: 401, body: { error: 'Invalid Google credential' } };
  }

  const googleEmail = payload.email?.toLowerCase();
  if (!googleEmail || !payload.email_verified) {
    return { status: 401, body: { error: 'Google account email is not verified' } };
  }

  // Check domain restriction
  const domain = googleEmail.split('@')[1];
  if (!ALLOWED_DOMAINS.includes(domain)) {
    return {
      status: 403,
      body: { error: `Access restricted to ${ALLOWED_DOMAINS.join(' and ')} accounts.` },
    };
  }

  // Match to an existing user in the database
  const user = db.findOne('users', (u) => u.email.toLowerCase() === googleEmail);
  if (!user) {
    return {
      status: 403,
      body: { error: `No Project Sync account found for ${googleEmail}. Contact your administrator.` },
    };
  }

  const token = createToken({
    id: user.id,
    email: user.email,
    role: user.role,
    level: user.level,
    office_code: user.office_code,
    is_exempt: user.is_exempt,
  });

  return {
    status: 200,
    body: {
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
        level: user.level,
        office_code: user.office_code,
        is_exempt: user.is_exempt,
      },
    },
  };
}

module.exports = { handleLogin, handleGoogleLogin, handleChangePassword, handleGetMe };
