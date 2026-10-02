/**
 * adzuna-atif.test.js — Bot ozeti e-postasinda "Jobs by Adzuna" (2 Ekim 2026).
 *
 * Calistir: node --test adzuna-atif.test.js
 *
 * Adzuna API sarti: Adzuna ilani yayinlanan her yerde "Jobs by Adzuna";
 * "Jobs" adzuna.co.uk'a, "Adzuna" yerine logo. E-posta da bir yayin.
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');
const { ozetIcerigi } = require('./lib/bot-ozet');

const ILAN = (kaynak) => ({ baslik: 'Data Analyst', sirket: 'Acme', konum: 'Surrey, BC', kaynak });

test('ZA1: listede Adzuna ilani varsa e-postada atif (metin + HTML, PNG logo mutlak adresle)', () => {
  const e = ozetIcerigi({ ilanlar: [ILAN('Greenhouse'), ILAN('Adzuna')], anahtar: 'analyst', kapatmaLinki: null, appUrl: 'https://app.test/' });
  assert.ok(e.text.includes('Jobs by Adzuna: https://www.adzuna.co.uk'));
  assert.ok(e.html.includes('<a href="https://www.adzuna.co.uk" style="color:#555">Jobs</a> by '));
  assert.ok(e.html.includes('<img src="https://app.test/adzuna/logo.png" alt="Adzuna" height="23"'));
  assert.ok(!/—/.test(e.text + e.html));
});

test('ZA2: Adzuna ilani yoksa ya da yalnizca gosterilmeyen (11.) siradaysa atif yok', () => {
  const yok = ozetIcerigi({ ilanlar: [ILAN('Job Bank'), ILAN(undefined)], anahtar: '', kapatmaLinki: null, appUrl: 'https://app.test' });
  assert.ok(!/Adzuna/.test(yok.text + yok.html));
  const onBir = [...Array.from({ length: 10 }, () => ILAN('Lever')), ILAN('Adzuna')];
  const e = ozetIcerigi({ ilanlar: onBir, anahtar: '', kapatmaLinki: null, appUrl: 'https://app.test' });
  assert.ok(!/Adzuna/.test(e.text + e.html), 'gosterilmeyen ilan icin atif');
});

test('ZA3: ozet sorgusu kaynak alanini da okuyor', () => {
  const d = fs.readFileSync(path.join(__dirname, 'lib', 'bot-depo.js'), 'utf8');
  assert.match(d, /select\('id,baslik,sirket,konum,kaynak,uygunluk'\)/);
});
