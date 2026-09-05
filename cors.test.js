/**
 * cors.test.js — preflight cevabi onbelleklenebilir mi?
 *
 * Neden var: 5 Eylul'e kadar index.js'te @fastify/cors `maxAge` olmadan
 * kayitliydi. Access-Control-Max-Age basligi gitmeyince Chrome kendi
 * varsayilani olan 5 saniyelik preflight onbellegini kullaniyor. Mulakatta
 * sorular arasi 20+ saniye var, yani her soru /cues ve /stream icin bir ek
 * gidis-donus odemis oluyordu.
 *
 * Uretimde olculdu (POST /api/v1/aid/cues, gecersiz govde, sunucu is yapmiyor):
 *   6 sn bosluktan sonra : 480 / 328 / 334 ms
 *   hemen ardindan       : 165 / 180 / 161 ms
 * Fark ~165 ms ve olculen ag tabani da 167 ms. Yani tam bir round-trip.
 *
 * Bu tek satir sessizce geri alinabilir ve geri alindiginda hicbir sey
 * bozulmaz, sadece her soru 165 ms yavaslar. O yuzden kilitliyoruz.
 *
 * Calistir: node cors.test.js
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

/** cors kaydinin govdesini ayikla: register(cors, { ... }) */
function corsOptionsBlock() {
  const start = src.indexOf('register(cors');
  assert.notStrictEqual(start, -1, 'index.js icinde register(cors ... bulunamadi');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  assert.fail('cors secenek blogu kapanmamis');
}

test('cors kaydinda maxAge var', () => {
  const block = corsOptionsBlock();
  assert.match(block, /\bmaxAge\s*:/, 'cors secenekleri arasinda maxAge yok');
});

test('maxAge en az 10 dakika, en fazla Chrome tavani (7200)', () => {
  const block = corsOptionsBlock();
  const m = block.match(/\bmaxAge\s*:\s*(\d+)/);
  assert.ok(m, 'maxAge sayisal bir deger degil');
  const secs = Number(m[1]);
  // 5 sn Chrome varsayilani; onu asmayan bir deger hicbir sey kazandirmaz.
  assert.ok(secs >= 600, `maxAge ${secs} sn cok kisa, en az 600 olmali`);
  // Chrome 7200'un ustunu kirpiyor. Daha buyuk deger yanlis guven verir.
  assert.ok(secs <= 7200, `maxAge ${secs} sn Chrome tavani 7200'u asiyor`);
});

test('Timing-Allow-Origin onRequest hookunda set ediliyor, onSend degil', () => {
  // Yorum satirlari da bu metni iceriyor; aranan sey basligi gercekten
  // KURAN ifade, ondan bahseden yorum degil.
  const i = src.search(/reply\s*\.\s*header\(\s*['"]Timing-Allow-Origin['"]/);
  assert.notStrictEqual(i, -1, 'Timing-Allow-Origin basligi hicbir yerde set edilmiyor');

  // Basligi kuran hook'un adini bul: geriye dogru en yakin addHook cagrisi.
  const before = src.slice(0, i);
  const last = before.lastIndexOf('addHook');
  assert.notStrictEqual(last, -1, 'Timing-Allow-Origin bir addHook icinde degil');
  const hook = before.slice(last).match(/addHook\(\s*['"]([a-zA-Z]+)['"]/);
  assert.ok(hook, 'addHook cagrisinin hook adi okunamadi');
  // onSend SSE (text/event-stream) yanitlarinda akisin ustune biner.
  assert.strictEqual(
    hook[1], 'onRequest',
    `Timing-Allow-Origin ${hook[1]} hookunda; SSE yanitlarini bozmamak icin onRequest olmali`,
  );
});
