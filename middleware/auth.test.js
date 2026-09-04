/**
 * middleware/auth.test.js — token dogrulama onbellegi
 *
 * Neden var: bu onbellek cevap yolunun uzerinde ve bir guvenlik siniri.
 * Yanlis giden her sey sessizce yanlis gider: TTL buyurse iptal edilen bir
 * oturum yasar, basarisiz dogrulama onbellege girerse yanlis token kabul
 * edilir, sinir kalkarsa bellek buyur.
 *
 * Calistir: node middleware/auth.test.js
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const {
  cachedUser, cacheUser, invalidateToken,
  TOKEN_TTL_MS, TOKEN_MAX, _tokenCache,
} = require('./auth');

const src = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');

test.beforeEach(() => _tokenCache.clear());

test('onbellege giren kullanici geri okunuyor', () => {
  cacheUser('tok-a', { id: 'u1', email: 'a@b.c' });
  assert.strictEqual(cachedUser('tok-a').id, 'u1');
});

test('farkli token farkli kullanici dondurur', () => {
  cacheUser('tok-a', { id: 'u1' });
  cacheUser('tok-b', { id: 'u2' });
  assert.strictEqual(cachedUser('tok-a').id, 'u1');
  assert.strictEqual(cachedUser('tok-b').id, 'u2');
  assert.strictEqual(cachedUser('tok-yok'), null);
});

test('ham token saklanmiyor, anahtar sha256 ozeti', () => {
  cacheUser('gizli-token-degeri', { id: 'u1' });
  const keys = [..._tokenCache.keys()];
  assert.strictEqual(keys.length, 1);
  assert.ok(!keys[0].includes('gizli-token-degeri'), 'ham token anahtar olarak duruyor');
  assert.match(keys[0], /^[0-9a-f]{64}$/, 'anahtar sha256 ozeti degil');
});

test('suresi dolan girdi dondurulmez ve silinir', () => {
  cacheUser('tok-a', { id: 'u1' });
  const key = [..._tokenCache.keys()][0];
  _tokenCache.get(key).expiresAt = Date.now() - 1;
  assert.strictEqual(cachedUser('tok-a'), null, 'suresi dolmus girdi donduruldu');
  assert.strictEqual(_tokenCache.has(key), false, 'suresi dolmus girdi silinmedi');
});

test('TTL 60 saniyeyi asmiyor', () => {
  // Bayatlik penceresi bu. Buyudukce iptal edilen oturum, dusurulen plan ve
  // alinan admin yetkisi daha uzun yasar.
  assert.ok(TOKEN_TTL_MS <= 60 * 1000, `TOKEN_TTL_MS ${TOKEN_TTL_MS} ms, 60 sn'yi asiyor`);
});

test('basarisiz dogrulama onbellege girmiyor', () => {
  cacheUser('tok-a', null);
  cacheUser('tok-b', undefined);
  assert.strictEqual(_tokenCache.size, 0, 'null/undefined kullanici onbellege girdi');
});

test('gecersiz kilma girdiyi hemen siliyor', () => {
  cacheUser('tok-a', { id: 'u1' });
  invalidateToken('tok-a');
  assert.strictEqual(cachedUser('tok-a'), null);
});

test('onbellek sinirsiz buyumuyor', () => {
  for (let i = 0; i < TOKEN_MAX + 50; i++) cacheUser('tok-' + i, { id: 'u' + i });
  assert.ok(_tokenCache.size <= TOKEN_MAX, `onbellek ${_tokenCache.size} girdiye ciktı, sinir ${TOKEN_MAX}`);
});

test('requireAuth basarisiz dogrulamayi onbellege yazmiyor', () => {
  // Kaynak kontrolu: cacheUser cagrisi 401 donusunun ONUNDE olmamali.
  const fn  = src.slice(src.indexOf('async function requireAuth'), src.indexOf('async function optionalAuth'));
  const i401 = fn.indexOf("status(401)");
  const iCache = fn.indexOf('cacheUser(token');
  assert.ok(i401 !== -1 && iCache !== -1, 'requireAuth beklenen bicimde degil');
  assert.ok(iCache > i401, 'cacheUser 401 kontrolunden once cagriliyor: gecersiz token onbellege girebilir');
});

test('onbellek okumasi Supabase cagrisindan once yapiliyor', () => {
  const fn = src.slice(src.indexOf('async function requireAuth'), src.indexOf('async function optionalAuth'));
  const iCached = fn.indexOf('cachedUser(token)');
  const iRemote = fn.indexOf('sb.auth.getUser(token)');
  assert.ok(iCached !== -1 && iRemote !== -1, 'requireAuth beklenen bicimde degil');
  assert.ok(iCached < iRemote, 'onbellek Supabase cagrisindan sonra okunuyor: hicbir tur kazanilmiyor');
});
