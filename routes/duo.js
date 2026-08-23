/**
 * server/routes/duo.js — Duo Modu (LockedIn Duo benzeri)
 *
 * Gerçek zamanlı SSE pub/sub:
 *   Interviewee → POST /question  → tüm yardımcılara push
 *   Helper      → POST /tip       → interviewee'ye push
 *   Her taraf   → GET  /subscribe → SSE stream
 *
 * Yeni paket gerekmez — Fastify + Node Readable stream.
 */

'use strict';

const { Readable } = require('stream');
const os           = require('os');
const crypto       = require('crypto');
const { requireAuth } = require('../middleware/auth');

// ── In-memory oturum deposu ────────────────────────────────────────────────────
// sessions: Map<sessionId, { ownerId, created, expiresAt, messages, streams }>
//
// The session code IS the credential the helper uses — they join as a guest,
// with no account. So it must be unguessable, must not be created by strangers,
// and must expire. Everything below follows from that.
const sessions = new Map();

const SESSION_TTL_MS      = 4 * 60 * 60 * 1000; // 4 hours
const MAX_SESSIONS_PER_USER = 3;

// Ambiguous characters (0/O, 1/I/L) left out so a code can be read aloud
// or typed from a phone screen without mistakes.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH   = 8;

/** Cryptographically random join code — ~1.1e12 combinations. */
function makeCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Look up a live session. Returns null for unknown or expired codes — it never creates one. */
function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    closeSession(s);
    return null;
  }
  return s;
}

/** Drop a session and hang up every stream attached to it. */
function closeSession(s) {
  for (const set of [s.intervieweeStreams, s.helperStreams]) {
    set.forEach((stream) => { try { stream.push(null); } catch {} });
    set.clear();
  }
  sessions.delete(s.id);
}

// Periodic sweep so abandoned sessions can't pile up in memory.
setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (now > s.expiresAt) closeSession(s);
  }
}, 15 * 60 * 1000).unref?.();

/** Public base URL of this API, used to build the helper link. */
function publicBaseUrl(request) {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/$/, '');
  const proto = request.headers['x-forwarded-proto'] || request.protocol || 'https';
  const host  = request.headers['x-forwarded-host'] || request.headers.host;
  return `${proto}://${host}`;
}

function push(streams, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  streams.forEach(s => { try { s.push(data); } catch {} });
}

// ── Yerel IP ───────────────────────────────────────────────────────────────────
function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── Helper HTML sayfası ────────────────────────────────────────────────────────
function helperHTML(sessionId = '') {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Interview Aid — Yardımcı Modu 🤝</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0d0f1a; color: rgba(255,255,255,.88); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; }
#app { max-width: 720px; margin: 0 auto; padding: 24px 16px 120px; }
h1 { font-size: 20px; font-weight: 700; color: #a5b4fc; margin-bottom: 4px; }
.sub { font-size: 12px; color: rgba(255,255,255,.4); margin-bottom: 24px; }
.panel { background: rgba(19,21,32,.8); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 18px; margin-bottom: 14px; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
.badge-on  { background: rgba(34,197,94,.12); border: 1px solid rgba(34,197,94,.25); color: #4ade80; }
.badge-off { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); color: rgba(255,255,255,.5); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: p 1.4s infinite; }
@keyframes p { 0%,100%{opacity:1}50%{opacity:.25} }
.q-card { background: #0f1120; border: 1px solid rgba(99,102,241,.3); border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
.q-tag { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.3); margin-bottom: 6px; }
.q-text { font-size: 15px; font-weight: 600; line-height: 1.5; }
.q-time { font-size: 11px; color: rgba(255,255,255,.3); margin-top: 5px; }
.tip-card { background: rgba(34,197,94,.06); border: 1px solid rgba(34,197,94,.15); border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; font-size: 13px; color: #4ade80; }
.send-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #111320; border-top: 1px solid rgba(255,255,255,.08); padding: 14px 16px; }
.send-inner { max-width: 720px; margin: 0 auto; }
.quicks { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.q-btn { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); color: rgba(255,255,255,.7); border-radius: 20px; padding: 5px 12px; font-size: 12px; cursor: pointer; transition: background .15s; }
.q-btn:hover { background: rgba(99,102,241,.2); }
.row { display: flex; gap: 10px; }
textarea { flex: 1; background: #0f1120; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; color: rgba(255,255,255,.88); padding: 10px 12px; font-size: 13px; resize: none; outline: none; font-family: inherit; }
textarea:focus { border-color: rgba(99,102,241,.5); }
.btn-send { background: #6366f1; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.btn-send:hover { background: #4f51c8; }
.btn-send:disabled { opacity: .5; cursor: default; }
input[type=text] { background: #0f1120; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; color: rgba(255,255,255,.88); padding: 9px 12px; font-size: 13px; outline: none; width: 100%; }
input:focus { border-color: rgba(99,102,241,.5); }
.empty { text-align: center; color: rgba(255,255,255,.25); padding: 40px 20px; font-size: 13px; }
</style>
</head>
<body>
<div id="app">
  <h1>🤝 Yardımcı Modu</h1>
  <p class="sub">Interview Aid — Arkadaşınızın mülakatını gerçek zamanlı takip edin ve ipuçları gönderin</p>

  <div class="panel" id="setup-panel">
    <div style="font-size:13px;font-weight:600;color:#a5b4fc;margin-bottom:12px">Bağlantı Kurulumu</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <div style="flex:1;min-width:180px">
        <label style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:4px;display:block">OTURUM KODU</label>
        <input type="text" id="session-input" placeholder="örn: ABC123" value="${sessionId}" />
      </div>
      <div style="flex:1;min-width:180px">
        <label style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:4px;display:block">İSMİNİZ (isteğe bağlı)</label>
        <input type="text" id="helper-name" placeholder="Ahmet" />
      </div>
    </div>
    <button onclick="connect()" style="background:#6366f1;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer">🔗 Bağlan</button>
  </div>

  <div id="status-bar" style="display:none;margin-bottom:16px">
    <span class="badge badge-on"><span class="dot"></span><span id="status-text">Bağlı</span></span>
    <span id="helper-count" style="font-size:12px;color:rgba(255,255,255,.4);margin-left:10px"></span>
  </div>

  <div id="questions-area">
    <div class="empty" id="empty-msg">Bağlandıktan sonra sorular burada görünecek…</div>
  </div>
</div>

<div class="send-bar">
  <div class="send-inner">
    <div class="quicks">
      <button class="q-btn" onclick="qt('⭐ STAR yöntemi kullan — Durum, Görev, Eylem, Sonuç!')">⭐ STAR</button>
      <button class="q-btn" onclick="qt('📊 Sayısal örnek ver! (%, $, süre)')">📊 Sayı</button>
      <button class="q-btn" onclick="qt('🎤 Biraz yavaşla, net konuş.')">🎤 Yavaşla</button>
      <button class="q-btn" onclick="qt('💡 Güçlü yanından bahset!')">💡 Güçlü Yan</button>
      <button class="q-btn" onclick="qt('👍 Harika gidiyor! Devam et.')">👍 Teşvik</button>
      <button class="q-btn" onclick="qt('⏱️ Kısa tut — max 2 dakika.')">⏱️ Süre</button>
    </div>
    <div class="row">
      <textarea id="tip-input" rows="2" placeholder="İpucu yaz… (Enter = gönder, Shift+Enter = yeni satır)" disabled></textarea>
      <button class="btn-send" id="btn-send" onclick="sendTip()" disabled>📤 Gönder</button>
    </div>
  </div>
</div>

<script>
let SESSION = '${sessionId}';
let es = null;

function connect() {
  SESSION = document.getElementById('session-input').value.trim();
  if (!SESSION) { alert('Oturum kodu gerekli'); return; }

  document.getElementById('setup-panel').style.display = 'none';
  document.getElementById('status-bar').style.display  = 'block';
  document.getElementById('status-text').textContent   = 'Bağlanıyor…';
  document.getElementById('tip-input').disabled  = false;
  document.getElementById('btn-send').disabled   = false;
  document.getElementById('empty-msg').textContent = 'Sorular bekleniyor…';

  es = new EventSource('/api/v1/duo/subscribe?session_id=' + encodeURIComponent(SESSION) + '&role=helper');

  es.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'connected') { document.getElementById('status-text').textContent = 'Bağlı ✓'; }
    else if (d.type === 'question') { addQuestion(d); }
    else if (d.type === 'tip_echo') { addTipEcho(d); }
    else if (d.type === 'ping')     { /* keep-alive, ignore */ }
  };

  es.onerror = () => {
    document.getElementById('status-text').textContent = '⚠️ Bağlantı kesildi — yenileniyor…';
    setTimeout(() => { try { es.close(); } catch{} connect(); }, 3000);
  };
}

function addQuestion(d) {
  const e = document.getElementById('empty-msg');
  if (e) e.remove();
  const card = document.createElement('div');
  card.className = 'q-card';
  const t = new Date(d.ts).toLocaleTimeString('tr-TR', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  card.innerHTML = '<div class="q-tag">🎤 MÜLAKATÇİ SORUSU</div>'
    + '<div class="q-text">' + d.question + '</div>'
    + '<div class="q-time">' + t + '</div>';
  document.getElementById('questions-area').prepend(card);
  window.scrollTo(0, 0);
}

function addTipEcho(d) {
  const c = document.createElement('div');
  c.className = 'tip-card';
  c.textContent = '✅ Gönderildi: ' + d.tip;
  document.getElementById('questions-area').prepend(c);
}

function qt(text) { document.getElementById('tip-input').value = text; sendTip(); }

function sendTip() {
  const tip  = document.getElementById('tip-input').value.trim();
  const name = document.getElementById('helper-name').value.trim() || 'Yardımcı';
  if (!tip || !SESSION) return;
  fetch('/api/v1/duo/tip', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ session_id: SESSION, tip, helper_name: name })
  });
  document.getElementById('tip-input').value = '';
}

document.getElementById('tip-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTip(); }
});

if (SESSION) setTimeout(connect, 200);
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
async function duoRoutes(fastify) {

  // ── Oturum aç (interviewee) ───────────────────────────────────────────────
  // Only a signed-in user can create a session, and the code comes from the
  // server — the browser no longer invents it.
  fastify.post('/session', { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user.id;

    const mine = [...sessions.values()].filter((s) => s.ownerId === ownerId);
    if (mine.length >= MAX_SESSIONS_PER_USER) {
      // Reclaim the oldest instead of refusing — the user probably left a tab open.
      mine.sort((a, b) => a.created - b.created);
      closeSession(mine[0]);
    }

    let id = makeCode();
    while (sessions.has(id)) id = makeCode();

    const now = Date.now();
    const session = {
      id,
      ownerId,
      created:   now,
      expiresAt: now + SESSION_TTL_MS,
      messages:  [],
      intervieweeStreams: new Set(),
      helperStreams:      new Set(),
    };
    sessions.set(id, session);

    fastify.log.info({ session_id: id, ownerId }, '[duo] Oturum açıldı');

    return {
      session_id: id,
      helper_url: `${publicBaseUrl(request)}/api/v1/duo/helper?session=${id}`,
      expires_at: new Date(session.expiresAt).toISOString(),
    };
  });

  // ── Oturumu kapat ─────────────────────────────────────────────────────────
  fastify.post('/session/close', { preHandler: requireAuth }, async (request, reply) => {
    const { session_id } = request.body ?? {};
    const session = getSession(session_id);
    if (!session) return { ok: true, already_closed: true };
    if (session.ownerId !== request.user.id) {
      return reply.code(403).send({ error: 'Not your session' });
    }
    closeSession(session);
    return { ok: true };
  });

  // ── SSE subscribe ─────────────────────────────────────────────────────────
  // EventSource cannot send headers, so the (now unguessable) code is the
  // credential here. Unknown or expired codes get 404 — no session is created.
  fastify.get('/subscribe', (request, reply) => {
    const { session_id, role } = request.query;
    if (!session_id) return reply.code(400).send({ error: 'session_id required' });

    const session = getSession(session_id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const readable = new Readable({ read() {} });

    const streams = role === 'helper' ? session.helperStreams : session.intervieweeStreams;
    streams.add(readable);

    // Son 30 mesajı yeni bağlananına gönder
    session.messages.slice(-30).forEach(m => {
      readable.push(`data: ${JSON.stringify(m)}\n\n`);
    });
    readable.push(`data: ${JSON.stringify({ type: 'connected', role, session_id })}\n\n`);

    // Keep-alive ping every 20s
    const ping = setInterval(() => {
      try { readable.push(`data: ${JSON.stringify({ type: 'ping' })}\n\n`); }
      catch { clearInterval(ping); }
    }, 20000);

    reply
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .send(readable);

    request.socket.on('close', () => {
      clearInterval(ping);
      streams.delete(readable);
      try { readable.push(null); } catch {}
      fastify.log.info({ session_id, role }, '[duo] İstemci ayrıldı');
    });
  });

  // ── Soru gönder (interviewee → helpers) ──────────────────────────────────
  // The candidate sends this, and the candidate is always a signed-in user.
  fastify.post('/question', { preHandler: requireAuth }, async (request, reply) => {
    const { session_id, question } = request.body ?? {};
    if (!session_id || !question) return reply.code(400).send({ error: 'session_id and question are required' });

    const session = getSession(session_id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    if (session.ownerId !== request.user.id) {
      return reply.code(403).send({ error: 'Not your session' });
    }
    const msg = { type: 'question', question, ts: Date.now() };
    session.messages.push(msg);
    if (session.messages.length > 200) session.messages.shift();

    push(session.helperStreams, msg);
    fastify.log.info({ session_id, helpers: session.helperStreams.size }, '[duo] Soru iletildi');
    return { ok: true, helpers_notified: session.helperStreams.size };
  });

  // ── İpucu gönder (helper → interviewee) ───────────────────────────────────
  fastify.post('/tip', async (request, reply) => {
    const { session_id, tip, helper_name = 'Yardımcı' } = request.body ?? {};
    if (!session_id || !tip) return reply.code(400).send({ error: 'session_id and tip are required' });

    // Helpers join as guests — the session code is what proves they were invited.
    const session = getSession(session_id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const msg = { type: 'tip', tip, helper_name, ts: Date.now() };
    session.messages.push(msg);

    push(session.intervieweeStreams, msg);
    // Echo back to all helpers so they see what was sent
    push(session.helperStreams, { ...msg, type: 'tip_echo' });

    fastify.log.info({ session_id, helper_name }, '[duo] İpucu iletildi');
    return { ok: true };
  });

  // ── Oturum bilgisi ─────────────────────────────────────────────────────────
  // Owner-only: this used to be an open "does this code exist?" oracle.
  fastify.get('/session-info', { preHandler: requireAuth }, async (request, reply) => {
    const { session_id } = request.query;
    const s = getSession(session_id);
    if (!s) return { connected_helpers: 0, messages: 0, exists: false };
    if (s.ownerId !== request.user.id) {
      return reply.code(403).send({ error: 'Not your session' });
    }
    return {
      connected_helpers: s.helperStreams.size,
      messages: s.messages.length,
      exists: true,
      age_seconds: Math.round((Date.now() - s.created) / 1000),
    };
  });

  // ── Yerel ağ IP ───────────────────────────────────────────────────────────
  // Kept for the Electron build, where helper and candidate share a LAN.
  // In the hosted app the helper link must be the public API URL — the old
  // version returned the container's private IP, which no phone can reach.
  fastify.get('/network-info', async (request) => ({
    local_ip:   getLocalIP(),
    port:       process.env.PORT || 3001,
    helper_url: `${publicBaseUrl(request)}/api/v1/duo/helper`,
  }));

  // ── Helper HTML sayfası ───────────────────────────────────────────────────
  // Public on purpose: the helper opens this link on their own phone, with no
  // account. An unknown code renders a plain message instead of a live console.
  fastify.get('/helper', async (request, reply) => {
    const { session } = request.query;
    const known = !!getSession(session);
    reply.header('Content-Type', 'text/html; charset=utf-8');
    if (!known) {
      return reply.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PlacedAI — session not found</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080a12;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;padding:24px">
<div><div style="font-size:40px;margin-bottom:12px">🔗</div>
<h1 style="font-size:18px;margin:0 0 8px">This session is not available</h1>
<p style="font-size:14px;color:rgba(255,255,255,.5);max-width:320px;margin:0 auto">
The code is wrong, or the session has ended. Ask for a fresh link — sessions expire after 4 hours.</p></div>
</body></html>`);
    }
    return reply.send(helperHTML(session));
  });

  fastify.log.info('[duo] Duo rotaları yüklendi');
}

module.exports = duoRoutes;
