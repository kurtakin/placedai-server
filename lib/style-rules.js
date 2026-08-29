/**
 * style-rules.js - Modelin urettigi metin "AI yazmis" gibi durmasin diye
 * her prose prompt'una eklenen ortak kural.
 *
 * Neden: uzun tire (em dash) kullanicinin en cok sikayet ettigi AI izi.
 * Prompt'un kendisi tire kullanirsa model taklit ediyor, o yuzden bu
 * dosyadaki metinde de hic tire yok.
 */

const NO_EM_DASH = `
PUNCTUATION RULE (strict): never write an em dash or an en dash. The characters
U+2014 and U+2013 are forbidden in your output. Use a comma, a period, a colon,
a semicolon, parentheses, or the word "and" instead. A hyphen inside a compound
word (well-known, data-driven) is fine.`;

module.exports = { NO_EM_DASH };
