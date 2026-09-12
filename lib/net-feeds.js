/**
 * server/lib/net-feeds.js — HTTP cekme ve besleme ayristirma.
 *
 * Tek kaynak: stripHTML, fetchURL, parseRSS ve parseAtom yalnizca burada
 * tanimlidir. routes/tools.js ve lib/job-sources.js buradan alir (K21).
 */

'use strict';

const https = require('https');
const http  = require('http');
const { URL: NodeURL } = require('url');

const TARAYICI_BASLIKLARI = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-CA,en;q=0.9',
  'Cache-Control': 'no-cache',
};

function stripHTML(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Govdeyi VE durum kodunu birlikte dondurur.
 *
 * fetchURL bunun sarmalayicisidir ve yalnizca govdeyi dondurur; bu yuzden
 * 404 donen bir adres orada basarili bir cagri gibi gorunur ve ayristirici
 * sessizce sifir sonuc uretir. Job Bank beslemesinin aylarca fark edilmeden
 * bozuk kalmasinin sebebi tam olarak buydu. Kaynak katmani bu yuzden
 * fetchWithStatus kullanir ve 200 disini hata sayar.
 */
function fetchWithStatus(rawUrl, { redirectCount = 0, headers = {}, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 4) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new NodeURL(rawUrl); }
    catch { return reject(new Error('Invalid URL')); }

    const client  = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      method:   'GET',
      headers:  { ...TARAYICI_BASLIKLARI, ...headers },
    };

    const req = client.request(options, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        return fetchWithStatus(loc, { redirectCount: redirectCount + 1, headers, timeoutMs }).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body:   Buffer.concat(chunks).toString('utf8', 0, 200000),
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

/** Eski cagiranlar icin: yalnizca govde. */
function fetchURL(rawUrl, redirectCount = 0) {
  return fetchWithStatus(rawUrl, { redirectCount }).then((r) => r.body);
}

/** Bir etiketin icerigini al: once CDATA, sonra duz metin. */
function etiketIcerigi(raw, tag) {
  const cdataM = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i').exec(raw);
  if (cdataM) return cdataM[1].trim();
  const tagM = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(raw);
  return tagM ? stripHTML(tagM[1]).trim() : '';
}

/** RSS 2.0 — <item> bloklari. */
function parseRSS(xml) {
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const raw = m[1];
    const get = (tag) => etiketIcerigi(raw, tag);
    const title   = get('title');
    const link    = get('link') || (/<link\s*\/?>([\s\S]*?)<\/(link|item)>/i.exec(raw) || [])[1] || '';
    const company = get('source') || get('author') || '';
    const desc    = get('description').slice(0, 400);
    const date    = get('pubDate');
    const location = get('location') || '';
    if (title && link) {
      items.push({ title, link: link.trim(), company, description: desc, date, location });
    }
  }
  return items;
}

/**
 * Atom 1.0 — <entry> bloklari.
 *
 * RSS'ten iki onemli farki var ve ikisi de parseRSS'i Atom uzerinde sessizce
 * sifir sonuca dusuruyor:
 *   1. Blok adi <item> degil <entry>.
 *   2. Baglanti etiketin metninde degil, <link href="..."/> ozniteliginde.
 *
 * Job Bank ozelinde isveren, konum ve maas <summary> icinde
 * "<strong>Employer:</strong> X<br/>" bicimindedir; bunlari da cikariyoruz.
 */
function parseAtom(xml) {
  const items = [];
  const entryRx = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRx.exec(xml)) !== null) {
    const raw = m[1];
    const title = etiketIcerigi(raw, 'title');

    // Once rel="alternate", yoksa rel'siz ilk link.
    const altM = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(raw)
              || /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i.exec(raw)
              || /<link[^>]*href=["']([^"']+)["']/i.exec(raw);
    const link = altM ? altM[1].trim() : '';

    const ozetHam = (new RegExp('<summary[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>', 'i').exec(raw) || [])[1]
                 || (new RegExp('<summary[^>]*>([\\s\\S]*?)<\\/summary>', 'i').exec(raw) || [])[1]
                 || '';

    const alan = (etiket) => {
      const r = new RegExp(`<strong>\\s*${etiket}\\s*:?\\s*<\\/strong>\\s*([\\s\\S]*?)(?:<br\\s*\\/?>|$)`, 'i').exec(ozetHam);
      return r ? stripHTML(r[1]).trim() : '';
    };

    const company  = alan('Employer') || etiketIcerigi(raw, 'author');
    const location = alan('Location');
    const salary   = alan('Salary');
    const date     = etiketIcerigi(raw, 'updated') || etiketIcerigi(raw, 'published');

    if (title && link) {
      items.push({
        title,
        link,
        company,
        location,
        salary,
        date,
        description: stripHTML(ozetHam).slice(0, 400),
      });
    }
  }
  return items;
}

module.exports = { stripHTML, fetchURL, fetchWithStatus, parseRSS, parseAtom };
