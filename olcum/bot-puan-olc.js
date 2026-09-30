/**
 * Botun basit uygunluk puani olcumu (K81). Calistir: node olcum/bot-puan-olc.js [-v]
 * Veri: olcum/bot-puan-indeed.json (46 gercek ilan, etiketler puanlamadan once yazildi).
 * ALAN=puanBecerisiz ile beceri parcasi olmadan siralama karsilastirilir.
 */
const path = require('path');
const S = path.join(__dirname, '..', 'lib');
const { uygunlukPuani } = require(path.join(S, 'bot-puan'));
const konum = require(path.join(S, 'konum'));
const veri = require('./bot-puan-indeed.json');
const dcg = (ls) => ls.reduce((a, l, i) => a + l / Math.log2(i + 2), 0);
const tablo = []; let tb = 0, tp = 0, ti = 0, n = 0;
const hepsi = [];
for (const a of veri.aramalar) {
  const prof = veri.profiller[a.kw];
  const k = konum.kullaniciKonumu(a.konum);
  const il = a.ilanlar.map(([title, company, location, etiket], i) => {
    const kademe = konum.siniflandir(k, location).kademe;
    const s = uygunlukPuani({ title }, { anahtar: a.kw, profil: prof, kademe });
    const s2 = uygunlukPuani({ title }, { anahtar: a.kw, profil: {}, kademe });
    return { title, location, etiket, kademe, ...s, puanBecerisiz: s2.puan, i };
  });
  hepsi.push(...il);
  const K = 5;
  const kaynak = il.slice(0, K).map((x) => x.etiket);
  const alan = process.env.ALAN || "puan"; const sirali = [...il].sort((x, y) => y[alan] - x[alan] || x.i - y.i).slice(0, K).map((x) => x.etiket);
  const ideal = [...il].map((x) => x.etiket).sort((x, y) => y - x).slice(0, K);
  const r = { arama: `${a.kw} @ ${a.not || a.konum}`, kaynakSirasi_ndcg5: +(dcg(kaynak) / dcg(ideal)).toFixed(2), puanSirasi_ndcg5: +(dcg(sirali) / dcg(ideal)).toFixed(2) };
  tablo.push(r); tb += r.kaynakSirasi_ndcg5; tp += r.puanSirasi_ndcg5; n++;
  if (process.argv[2] === '-v') il.sort((x, y) => y.puan - x.puan).forEach((x) => console.log(String(x.puan).padStart(3), x.etiket, x.kademe.padEnd(16), JSON.stringify(x.parcalar), x.title, '|', x.location));
}
console.table(tablo);
console.log('ortalama nDCG@5  kaynak sirasi:', (tb / n).toFixed(2), ' puan sirasi:', (tp / n).toFixed(2));
const ort = (f) => { const g = {}; for (const x of hepsi) { (g[x.etiket] ||= []).push(f(x)); } return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)])); };
console.log('etikete gore ortalama puan:', ort((x) => x.puan), ' beceri parcasi:', ort((x) => x.parcalar.beceri));
console.log('beceri parcasi >0 olan ilan:', hepsi.filter((x) => x.parcalar.beceri > 0).length, '/', hepsi.length);
console.log('kademe dagilimi:', hepsi.reduce((a, x) => (a[x.kademe] = (a[x.kademe] || 0) + 1, a), {}));
