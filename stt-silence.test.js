/**
 * stt-silence.test.js — sunucu VAD sessizlik esigi kilitli mi?
 *
 * Calistir: node stt-silence.test.js
 *
 * Neden var: bu tek sayi gecikme zincirinin en buyuk tek kalemi. 5 Eylul'de
 * uretimde olculdu, overlay'in kendi kod yolunda, sesin bitisinden ipucunun
 * ekrana gelmesine kadar:
 *
 *   500 ms : 1.459 / 1.405 / 1.498 ms
 *   300 ms : 1.009 / 1.009 ms
 *
 * ~450 ms fark. Ilk kismi metnin gecikmesi neredeyse birebir esige esit.
 *
 * Iki yonlu tehlike, o yuzden hem alt hem ust sinir kilitli:
 *
 *   Yukari kacarsa  - gecikme geri gelir, kimse fark etmez, hicbir test
 *                     dusmez. 500'e donmek 450 ms kaybetmek demek.
 *   Asagi kacarsa   - esik konusmacinin cumle ici duraklamasindan kisa
 *                     kalir, tur erken kapanir, soru ikiye bolunur. Olculdu:
 *                     300+350 ms duraklama butun, 300+500 ms bolundu,
 *                     200+350 ms bolundu. Bolunme artik onarilabiliyor
 *                     (overlay'de joinIfContinuation) ama bedava degil.
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'routes', 'stt.js'), 'utf8');

/** SILENCE_MS bloklarindaki varsayilani ve sinirlari kaynaktan oku. */
function readNumbers() {
  const block = src.slice(src.indexOf('const SILENCE_MS'), src.indexOf('async function sttRoutes'));
  assert.ok(block.length > 100, 'SILENCE_MS blogu stt.js icinde bulunamadi');
  const def   = block.match(/return\s+(\d+)\s*;/);
  const clamp = block.match(/Math\.min\(\s*(\d+)\s*,\s*Math\.max\(\s*(\d+)\s*,/);
  assert.ok(def,   'SILENCE_MS varsayilani okunamadi');
  assert.ok(clamp, 'SILENCE_MS alt/ust siniri okunamadi');
  return { varsayilan: +def[1], ust: +clamp[1], alt: +clamp[2] };
}

test('turn_detection sabit sayi degil, SILENCE_MS kullaniyor', () => {
  assert.match(src, /silence_duration_ms:\s*SILENCE_MS/,
    'silence_duration_ms sabit bir sayiya geri donmus');
  assert.doesNotMatch(src, /silence_duration_ms:\s*\d/,
    'silence_duration_ms hala sabit sayi iceriyor');
});

test('varsayilan 300 ms', () => {
  assert.strictEqual(readNumbers().varsayilan, 300);
});

test('varsayilan olculen bolunme esiginin ustunde (>= 300)', () => {
  // 200 + 350 ms duraklama bolundu; 300 + 350 ms butun kaldi.
  assert.ok(readNumbers().varsayilan >= 300,
    'varsayilan 300 ms altina indi — olculen bolunme bolgesi');
});

test('varsayilan eski 500 ms degerine geri donmemis', () => {
  // 500'e donmek olculen 450 ms'yi geri vermek demek, ve sessizce olur.
  assert.ok(readNumbers().varsayilan < 500,
    'varsayilan 500 ms veya ustune cikti — olculen 450 ms kaybedildi');
});

test('ortam degiskeni sinirlanmis (200-800)', () => {
  const n = readNumbers();
  assert.strictEqual(n.alt, 200, 'alt sinir 200 olmali');
  assert.strictEqual(n.ust, 800, 'ust sinir 800 olmali');
});

test('esik istemciye donuyor (olcum ve hata ayiklama icin)', () => {
  assert.match(src, /silence_ms:\s*SILENCE_MS/,
    'mint cevabinda silence_ms yok — istemci hangi esikle calistigini bilemez');
});
