'use strict';
/**
 * Gecerli PDF uretici (xref + trailer dahil). Elle kurulmus sahte PDF'ler
 * pdfjs tarafindan reddediliyor; gercek ayristiriciyi olcmek icin gercek
 * yapida dosya gerekiyor.
 *
 * identityH:true -> Type0 / CIDFontType2 / Identity-H + ToUnicode CMap.
 * Icerik akisinda harf yok, glif numarasi var; metne ancak ToUnicode
 * tablosu okunarak ulasilir. Kullanicinin gercek Word CV'si bu bicimde.
 */
function gercekPdfYap(metin, { identityH = false } = {}) {
  const nesneler = [];
  const ekle = (govde) => { nesneler.push(govde); return nesneler.length; };

  let icerik;
  let fontNesnesi;

  if (identityH) {
    // Glif numaralari: gid = karakter sirasi + 1 (0 = .notdef)
    const harfler = [...new Set(metin.split(''))];
    const gid = new Map(harfler.map((h, i) => [h, i + 1]));
    const hex = metin.split('')
      .map((h) => gid.get(h).toString(16).padStart(4, '0').toUpperCase()).join('');
    icerik = `BT /F1 12 Tf 1 0 0 1 40 720 Tm [<${hex}>] TJ ET`;

    const bfchar = harfler.map((h) =>
      `<${gid.get(h).toString(16).padStart(4, '0').toUpperCase()}> ` +
      `<${h.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}>`).join('\n');
    const cmap = [
      '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
      '/CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def',
      '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
      '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
      `${harfler.length} beginbfchar`, bfchar, 'endbfchar',
      'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end',
    ].join('\n');

    const toUni = ekle(`<</Length ${cmap.length}>>\nstream\n${cmap}\nendstream`);
    const tanim = ekle('<</Type/FontDescriptor/FontName/AAAAAA+Calibri/Flags 32'
      + '/FontBBox[-500 -300 1500 1000]/ItalicAngle 0/Ascent 750/Descent -250'
      + '/CapHeight 700/StemV 80>>');
    const cid = ekle('<</Type/Font/Subtype/CIDFontType2/BaseFont/AAAAAA+Calibri'
      + '/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>'
      + `/FontDescriptor ${tanim} 0 R/DW 600>>`);
    fontNesnesi = ekle('<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Calibri'
      + `/Encoding/Identity-H/DescendantFonts[${cid} 0 R]/ToUnicode ${toUni} 0 R>>`);
  } else {
    icerik = `BT /F1 12 Tf 1 0 0 1 40 720 Tm (${metin}) Tj ET`;
    fontNesnesi = ekle('<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>');
  }

  const akis = ekle(`<</Length ${icerik.length}>>\nstream\n${icerik}\nendstream`);
  const sayfa = nesneler.length + 1;   // bir sonraki ekle() bu numarayi alir
  const agac  = nesneler.length + 2;
  ekle(`<</Type/Page/Parent ${agac} 0 R/MediaBox[0 0 612 792]`
    + `/Resources<</Font<</F1 ${fontNesnesi} 0 R>>>>/Contents ${akis} 0 R>>`);
  ekle(`<</Type/Pages/Kids[${sayfa} 0 R]/Count 1>>`);
  const kok = ekle(`<</Type/Catalog/Pages ${agac} 0 R>>`);

  let pdf = '%PDF-1.7\n';
  const yer = [];
  nesneler.forEach((g, i) => {
    yer.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${g}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${nesneler.length + 1}\n0000000000 65535 f \n`;
  yer.forEach((o) => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<</Size ${nesneler.length + 1}/Root ${kok} 0 R>>\n`
       + `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
module.exports = { gercekPdfYap };
