/**
 * lib/logging.test.js — uretimde log yaziliyor mu, ve ne yaziyor?
 *
 * Neden var: 4 Eylul'e kadar index.js'te `logger: NODE_ENV !== 'production'`
 * yaziyordu. Railway'de NODE_ENV=production, yani logger: false. 77 adet
 * fastify.log cagrisinin (42'si error) hicbiri hicbir yere yazmadi. Bir
 * haftalik Railway logunda tek bir [aid] satiri yoktu. Gecikme calismasinin
 * tamami o satirlara dayaniyor ve uretim hatalari da oradan gorunuyor.
 *
 * Bu sessizce geri alinabilecek bir satir, o yuzden kilitliyoruz. Ikinci
 * yarisi gizlilik: landing sayfasi "sorularin metnini loglamiyoruz" diyor.
 *
 * Calistir: node lib/logging.test.js
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT      = path.join(__dirname, '..');
const indexSrc  = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

const logCall = /(?:fastify|app|request|req)\.log\.(?:info|warn|error|debug)\s*\(([\s\S]{0,220}?)\)\s*;/g;

function allLogCalls() {
  const out = [];
  for (const f of ['routes', 'lib']) {
    const dir = path.join(ROOT, f);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
      const src = fs.readFileSync(path.join(dir, name), 'utf8');
      let m;
      logCall.lastIndex = 0;
      while ((m = logCall.exec(src)) !== null) out.push({ file: f + '/' + name, args: m[1] });
    }
  }
  return out;
}

test('logger uretimde de acik', () => {
  assert.ok(!/logger:\s*process\.env\.NODE_ENV\s*!==\s*'production'/.test(indexSrc),
    'logger uretimde kapali: butun fastify.log cagrilari sessizce yutuluyor');
  assert.ok(/logger:\s*\{/.test(indexSrc) || /logger:\s*true/.test(indexSrc),
    'logger yapilandirmasi bulunamadi');
});

test('Authorization basligi log yapilandirmasinda gizleniyor', () => {
  // Anahtarin tam adini ariyoruz. Ilk yazimda sadece /redact/ ariyordum ve
  // anahtari _redact'e cevirmek testi gecti: mutasyon hayatta kaldi.
  const m = indexSrc.match(/(?:^|[\s{,])redact:\s*\{([\s\S]{0,400}?)\}/);
  assert.ok(m, 'redact anahtari yok: bir kaza Authorization basligini loga dusurebilir');
  assert.ok(/req\.headers\.authorization/.test(m[1]), 'authorization basligi redact listesinde degil');
});

test('istek loglari kapali, sadece kasitli satirlar yaziliyor', () => {
  assert.ok(/disableRequestLogging:\s*true/.test(indexSrc),
    'her istek icin otomatik satir yaziliyor: olcum satirlari gurultude kayboluyor');
});

test('hicbir log satiri kullanici metnini tasimiyor', () => {
  // Soru, cevap, CV, transkript ve serbest metin loga girmemeli. Uzunluk ve
  // sayi alanlari serbest: contentChars, text_length, rawChars, answerChars.
  const YASAK = /(?<![A-Za-z])(question|answer|prompt|transcript|cv_text|jd_context|memory|user_answer|content|raw)(?![A-Za-z_])/;
  const IZINLI = /(Chars|_length|Count|Found|Preview|\.length|questionFound|qCount)/;
  // Etiket metinlerini ('[aid/answer] error' gibi) taramadan cikar: onlar
  // sabit dize, loglanan bir alan degil. Ilk yazimda bu ayrimi yapmamistim ve
  // test kendi yanlis alarmini uretti.
  const alanlar = (args) => args.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
  const kirli = allLogCalls().filter(c => YASAK.test(alanlar(c.args)) && !IZINLI.test(c.args));
  assert.deepStrictEqual(kirli.map(c => c.file + ': ' + c.args.replace(/\s+/g, ' ').slice(0, 90)), [],
    'bu log satirlari kullanici metni tasiyor olabilir');
});
