'use strict';

/**
 * server/routes/auth.js
 * POST /api/v1/auth/register — create a new local account
 * POST /api/v1/auth/login    — sign in with email + password
 *
 * Storage strategy:
 *   • If SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set → use Supabase Auth.
 *   • Otherwise → local JSON file store at {appDataDir}/users.json  (dev mode).
 *
 * Token strategy: simple signed JWT (jsonwebtoken), 7-day expiry.
 * Falls back to crypto HMAC token if jsonwebtoken is not installed.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'interview-aid-dev-secret-change-in-prod';
const TOKEN_TTL  = 7 * 24 * 60 * 60; // 7 days in seconds

// ── Simple local user store (dev mode only) ───────────────────────────────────
const STORE_PATH = path.join(os.homedir(), '.interview-aid', 'users.json');

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    }
  } catch (_) {}
  return {};
}

function saveStore(store) {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

// ── Password hashing (Node built-in, no bcrypt needed) ───────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

// ── Token helpers ─────────────────────────────────────────────────────────────
function makeToken(payload) {
  // Try jsonwebtoken first (might not be installed yet)
  try {
    const jwt = require('jsonwebtoken');
    return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
  } catch (_) {
    // Fallback: simple HMAC-SHA256 token  <header.payload.sig>
    const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body    = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL })).toString('base64url');
    const sig     = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  }
}

function verifyToken(token) {
  try {
    const jwt = require('jsonwebtoken');
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    // Fallback verify
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  }
}

// ── Lazy Supabase client ──────────────────────────────────────────────────────
let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

// ── Route plugin ─────────────────────────────────────────────────────────────
async function authRoutes(fastify) {

  // POST /api/v1/auth/register
  fastify.post('/register', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'email', 'password'],
        properties: {
          name:     { type: 'string', minLength: 1,  maxLength: 80 },
          email:    { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6,  maxLength: 128 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { name, email, password } = req.body;
    const sb = getSupabase();

    if (sb) {
      // ── Supabase Auth ─────────────────────────────────────────────────────
      const { data, error } = await sb.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name },
      });

      if (error) {
        const msg = error.message.includes('already registered')
          ? 'An account with this email already exists.'
          : error.message;
        return reply.status(400).send({ error: msg });
      }

      const token = makeToken({ sub: data.user.id, email, name });
      return reply.status(201).send({ token, user: { id: data.user.id, email, name } });

    } else {
      // ── Local store (dev mode) ────────────────────────────────────────────
      const store = loadStore();
      const key   = email.toLowerCase();

      if (store[key]) {
        return reply.status(400).send({ error: 'An account with this email already exists.' });
      }

      const id = crypto.randomUUID();
      store[key] = { id, name, email, passwordHash: hashPassword(password), tier: 'PRO', createdAt: new Date().toISOString() };
      saveStore(store);

      const token = makeToken({ sub: id, email, name });
      return reply.status(201).send({ token, user: { id, email, name } });
    }
  });

  // POST /api/v1/auth/login
  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { email, password } = req.body;
    const sb = getSupabase();

    if (sb) {
      // ── Supabase Auth ─────────────────────────────────────────────────────
      const { data, error } = await sb.auth.signInWithPassword({ email, password });

      if (error || !data?.user) {
        return reply.status(401).send({ error: 'Invalid email or password.' });
      }

      const token = makeToken({ sub: data.user.id, email: data.user.email });
      const name  = data.user.user_metadata?.name || '';
      return reply.send({ token, user: { id: data.user.id, email: data.user.email, name } });

    } else {
      // ── Local store (dev mode) ────────────────────────────────────────────
      const store = loadStore();
      const key   = email.toLowerCase();
      const rec   = store[key];

      if (!rec || !verifyPassword(password, rec.passwordHash)) {
        return reply.status(401).send({ error: 'Invalid email or password.' });
      }

      const token = makeToken({ sub: rec.id, email: rec.email, name: rec.name });
      return reply.send({ token, user: { id: rec.id, email: rec.email, name: rec.name } });
    }
  });

  // GET /api/v1/auth/me — verify token, return user info
  fastify.get('/me', async (req, reply) => {
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing token.' });
    }
    const payload = verifyToken(authHeader.slice(7));
    if (!payload) return reply.status(401).send({ error: 'Invalid or expired token.' });
    return reply.send({ user: { id: payload.sub, email: payload.email, name: payload.name || '' } });
  });
}

module.exports = authRoutes;
