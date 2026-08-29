/**
 * server/lib/mailer.js — E-posta gönderici
 *
 * Production: Resend HTTPS API (api.resend.com/emails).
 *   Railway'in Free / Trial / Hobby planlarında giden SMTP portları (25, 465,
 *   587) spam'i önlemek için kapalı. SMTP denemesi hata vermiyor, sessizce
 *   dakikalarca bekleyip "Connection timeout" ile düşüyor. HTTPS/443 açık
 *   olduğu için Resend'in HTTP API'sini kullanıyoruz.
 *
 *   RESEND_API_KEY = re_xxx                       (Resend > API keys)
 *   MAIL_FROM      = PlacedAI <noreply@placedai.app>
 *   NOTIFY_EMAIL   = info@placedai.app            (bildirimler nereye gitsin)
 *   MAIL_TIMEOUT_MS (opsiyonel, varsayılan 8000)
 *
 * Yedek (yalnızca yerel geliştirme — Railway'de SMTP çalışmaz):
 *   GMAIL_USER         = sizin@gmail.com
 *   GMAIL_APP_PASSWORD = xxxx xxxx xxxx xxxx      (Google App Password)
 */

'use strict';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = Number(process.env.MAIL_TIMEOUT_MS) || 8000;

const DEFAULT_FROM   = 'PlacedAI <noreply@placedai.app>';
const DEFAULT_NOTIFY = 'info@placedai.app';

function usingResend() {
  return !!process.env.RESEND_API_KEY;
}

function usingGmail() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function fromAddress() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  if (!usingResend() && process.env.GMAIL_USER) return `"PlacedAI" <${process.env.GMAIL_USER}>`;
  return DEFAULT_FROM;
}

function toAddress() {
  return process.env.NOTIFY_EMAIL || process.env.GMAIL_USER || DEFAULT_NOTIFY;
}

/** E-posta servisinin yapılandırılmış olup olmadığını kontrol et */
function isConfigured() {
  return usingResend() || usingGmail();
}

// ── Resend HTTP API ───────────────────────────────────────────────────────
async function sendViaResend(msg) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    msg.from,
        to:      Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.text ? { text: msg.text } : {}),
      }),
      signal: ctrl.signal,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Resend hata gövdesi: { statusCode, name, message }
      return { ok: false, error: body.message || body.name || `Resend HTTP ${res.status}` };
    }
    return { ok: true, id: body.id };
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `no response in ${SEND_TIMEOUT_MS}ms`
      : err.message;
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

// ── Gmail SMTP (yalnızca yerel geliştirme) ────────────────────────────────
let _smtp = null;
async function sendViaGmail(msg) {
  try {
    if (!_smtp) {
      const nodemailer = require('nodemailer');
      _smtp = nodemailer.createTransport({
        host:   'smtp.gmail.com',
        port:   465,
        secure: true,
        auth:   { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      });
    }
    const info = await _smtp.sendMail(msg);
    return { ok: true, id: info.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Tek gönderim noktası. Asla throw etmez.
 * @param {{from?:string, to?:string|string[], subject:string, text?:string, html?:string}} msg
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
async function sendMail(msg = {}) {
  if (!msg.subject)            return { ok: false, error: 'subject required' };
  if (!msg.text && !msg.html)  return { ok: false, error: 'text or html required' };

  const payload = {
    from:    msg.from || fromAddress(),
    to:      msg.to   || toAddress(),
    subject: msg.subject,
    text:    msg.text,
    html:    msg.html,
  };

  if (usingResend()) return sendViaResend(payload);
  if (usingGmail())  return sendViaGmail(payload);
  return { ok: false, error: 'Email is not configured: RESEND_API_KEY (or GMAIL_USER + GMAIL_APP_PASSWORD) is missing' };
}

/**
 * Başvuru bildirimi e-postası gönder.
 * @param {{company:string, role:string, date:string, status:string, url:string, notes:string}} app
 * @returns {Promise<{ok:boolean, info?:string, error?:string}>}
 */
async function sendApplicationNotification(app) {
  const subject = `📤 Yeni Başvuru: ${app.role} @ ${app.company}`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#0d0f1a;color:#e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#6366f1;padding:20px 28px">
        <div style="font-size:22px;font-weight:700;color:#fff">📤 Yeni Başvuru Kaydedildi</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-top:4px">PlacedAI · Başvuru Takibi</div>
      </div>
      <div style="padding:24px 28px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#94a3b8;font-size:13px;width:120px">Şirket</td><td style="font-weight:600;font-size:15px;color:#f1f5f9">${app.company || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;font-size:13px">Pozisyon</td><td style="font-weight:600;font-size:15px;color:#f1f5f9">${app.role || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;font-size:13px">Tarih</td><td style="color:#f1f5f9">${app.date || new Date().toISOString().slice(0, 10)}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;font-size:13px">Durum</td><td><span style="background:#1e293b;border:1px solid #334155;padding:3px 10px;border-radius:6px;font-size:13px;color:#a5b4fc">${app.status || 'Başvuruldu'}</span></td></tr>
          ${app.notes ? `<tr><td style="padding:8px 0;color:#94a3b8;font-size:13px">Notlar</td><td style="color:#cbd5e1;font-size:13px">${app.notes}</td></tr>` : ''}
          ${app.url   ? `<tr><td style="padding:8px 0;color:#94a3b8;font-size:13px">İlan</td><td><a href="${app.url}" style="color:#818cf8;font-size:13px">${app.url}</a></td></tr>` : ''}
        </table>

        <div style="margin-top:24px;padding:14px 16px;background:#1e293b;border-radius:8px;font-size:13px;color:#94a3b8">
          💡 Bu başvuru PlacedAI Takip Panelinde kayıtlı. Durumunu takip etmeyi unutma!
        </div>
      </div>
      <div style="padding:14px 28px;border-top:1px solid #1e293b;font-size:11px;color:#475569;text-align:center">
        PlacedAI · ${new Date().toLocaleDateString('tr-TR', { day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' })}
      </div>
    </div>
  `;

  const res = await sendMail({ to: toAddress(), subject, html });
  return res.ok ? { ok: true, info: res.id } : { ok: false, error: res.error };
}

module.exports = { sendMail, sendApplicationNotification, isConfigured, fromAddress, toAddress };
