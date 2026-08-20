/**
 * server/lib/mailer.js — Gmail SMTP e-posta gönderici
 *
 * .env gerekli:
 *   GMAIL_USER         = sizin@gmail.com
 *   GMAIL_APP_PASSWORD = xxxx xxxx xxxx xxxx   (Google App Password)
 *   NOTIFY_EMAIL       = bildirim@email.com    (e-posta nereye gitsin — boşsa GMAIL_USER)
 */

'use strict';

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) return null;

  _transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   465,
    secure: true,
    auth:   { user, pass },
  });

  return _transporter;
}

/**
 * Başvuru bildirimi e-postası gönder.
 * @param {{company:string, role:string, date:string, status:string, url:string, notes:string}} app
 * @returns {Promise<{ok:boolean, info?:string, error?:string}>}
 */
async function sendApplicationNotification(app) {
  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: 'GMAIL_USER veya GMAIL_APP_PASSWORD .env dosyasında eksik' };
  }

  const to      = process.env.NOTIFY_EMAIL || process.env.GMAIL_USER;
  const subject = `📤 Yeni Başvuru: ${app.role} @ ${app.company}`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#0d0f1a;color:#e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#6366f1;padding:20px 28px">
        <div style="font-size:22px;font-weight:700;color:#fff">📤 Yeni Başvuru Kaydedildi</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-top:4px">Interview Aid — Başvuru Takibi</div>
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
          💡 Bu başvuru Interview Aid Takip Panelinde kayıtlı. Durumunu takip etmeyi unutma!
        </div>
      </div>
      <div style="padding:14px 28px;border-top:1px solid #1e293b;font-size:11px;color:#475569;text-align:center">
        Interview Aid · ${new Date().toLocaleDateString('tr-TR', { day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' })}
      </div>
    </div>
  `;

  try {
    const info = await transporter.sendMail({ from: `"Interview Aid" <${process.env.GMAIL_USER}>`, to, subject, html });
    return { ok: true, info: info.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * E-posta servisinin yapılandırılmış olup olmadığını kontrol et
 */
function isConfigured() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

module.exports = { sendApplicationNotification, isConfigured };
