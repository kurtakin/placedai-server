#!/usr/bin/env node
/**
 * rebuild-index.js - question_bank_index.json'i klasordeki dosyalardan yeniden uretir.
 *
 * Neden var: routes/practice.js bankayi index.files listesini gezerek yukluyor.
 * Yeni bir sektor dosyasi eklenip indekse yazilmazsa sunucu o dosyayi hic gormez
 * ve sessizce eski sayida soru servis eder. Bu betik o sessiz hatayi imkansiz kilar.
 *
 * Kullanim:  node questions/rebuild-index.js
 * Ayrica her sektor dosyasinin metadata.total ve categories alanlarini
 * gercek icerikten yeniden hesaplar, boylece sayilar uydurma kalamaz.
 */
const fs   = require('fs');
const path = require('path');

const DIR = __dirname;
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('_questions.json')).sort();

const seen = new Map();   // id -> dosya, tum banka genelinde tekillik icin
const entries = [];
let grandTotal = 0;

for (const file of files) {
  const full = path.join(DIR, file);
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  const qs   = data.questions || [];

  for (const q of qs) {
    if (seen.has(q.id)) {
      throw new Error(`Ayni id iki dosyada: ${q.id} (${seen.get(q.id)} ve ${file})`);
    }
    seen.set(q.id, file);
    for (const field of ['id', 'category', 'seniority', 'text', 'answer_framework']) {
      if (!q[field]) throw new Error(`${file}: ${q.id} icinde ${field} eksik`);
    }
  }

  // Ayni soru metni bir dosyada iki kez olmamali. Accounting bankasi 40 satir
  // tasiyordu ve kirkinin metni de birebir ayniydi; indeks 40 soru sayiyordu,
  // Practice modu ayni soruyu kirk kez servis ediyordu ve kimse fark etmemisti.
  // Uretim hatasi sessizce yayina cikti. Bir daha cikamaz.
  const textSeen = new Map();
  for (const q of qs) {
    const key = String(q.text).trim().toLowerCase();
    if (textSeen.has(key)) {
      throw new Error(
        `${file}: ayni soru metni iki kez var (${textSeen.get(key)} ve ${q.id})\n  "${String(q.text).slice(0, 70)}"`
      );
    }
    textSeen.set(key, q.id);
  }

  // Cerceve de tekrar etmemeli. Ayni cevap cercevesinin bir dosyada birden
  // fazla kez gecmesi neredeyse her zaman kopyala yapistir uretim hatasidir.
  const fwSeen = new Map();
  for (const q of qs) {
    const key = JSON.stringify(q.answer_framework);
    if (fwSeen.has(key)) {
      throw new Error(
        `${file}: ayni answer_framework iki kez var (${fwSeen.get(key)} ve ${q.id})`
      );
    }
    fwSeen.set(key, q.id);
  }

  // Kategori "manager" ise seniority icinde de "manager" olmali.
  //
  // Neden: routes/practice.js:400 pratik sorularini seniority alanina gore
  // filtreliyor. Etiket yoksa o soru "manager" seviyesini secen kullaniciya
  // HIC gorunmuyor. 4 Eylul'de 273 manager sorusunun 63'unde bu etiket
  // eksikti; Property Management ve QA / Testing bankalari manager
  // seviyesinde tamamen bostu.
  //
  // Ustteki iki guard (ayni metin, ayni answer_framework) bunu yakalayamiyordu:
  // ikisi de icerigin kendini kontrol ediyor, kategori ile seniority
  // arasindaki tutarliligi kimse kontrol etmiyordu.
  for (const q of qs) {
    if (q.category === 'manager' && !(q.seniority || []).includes('manager')) {
      throw new Error(
        `${file}: ${q.id} kategorisi manager ama seniority icinde manager yok ` +
        `(${JSON.stringify(q.seniority || [])}). ` +
        `practice.js seniority ile filtreliyor, bu soru manager seviyesinde gorunmez.`
      );
    }
  }

  const categories = [...new Set(qs.map((q) => q.category))].sort();
  const seniority  = [...new Set(qs.flatMap((q) => q.seniority))].sort();

  data.metadata.total      = qs.length;
  data.metadata.categories = categories;
  fs.writeFileSync(full, JSON.stringify(data, null, 2) + '\n', 'utf8');

  entries.push({ file, sector: data.metadata.sector, total: qs.length, categories, seniority_levels: seniority });
  grandTotal += qs.length;
}

const indexPath = path.join(DIR, 'question_bank_index.json');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
index.metadata.grand_total = grandTotal;
index.metadata.total_files = files.length;
index.metadata.generated   = new Date().toISOString().slice(0, 10);
index.files = entries;
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

console.log(`Banka: ${grandTotal} soru, ${files.length} sektor dosyasi`);
for (const e of entries) console.log(`  ${String(e.total).padStart(4)}  ${e.sector}`);
console.log('\nLanding page bu sayilari tasiyor, guncellemeyi unutma:');
console.log('  interview-aid-web/app/(public)/page.tsx');
