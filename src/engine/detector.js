'use strict';

const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const ARABIC_DIGITS = {
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

function detectLanguage(text) {
  if (!text || !text.trim()) return 'en';
  const compact = String(text).replace(/\s/g, '');
  if (!compact) return 'en';
  const arabicCount = (compact.match(ARABIC_REGEX) || []).length;
  return arabicCount / compact.length >= 0.2 ? 'ar' : 'en';
}

// Distinctive per-dialect marker WORDS. Biased toward words that strongly signal
// ONE dialect and are rare in the others ("ازاي"/"دلوقتي" Egyptian; "وش"/"شلون"/
// "وايد" Gulf; "شو"/"ليش"/"هلق" Levantine). Written in their NORMALIZED spelling
// (ة→ه, أإآ→ا, ى→ي) since matching runs on normalized text. Standalone-word
// matching uses Arabic-aware boundaries (below), NOT \b — Arabic letters aren't
// \w, so \b silently never fires around them.
const DIALECT_MARKER_WORDS = {
  egyptian: [
    'ازاي', 'ازايك', 'دلوقتي', 'دلوقت', 'عايز', 'عاوز', 'عايزه', 'عاوزه',
    'علشان', 'عشان', 'كده', 'كدا', 'اوي', 'ايه', 'فين', 'بتاع', 'بتاعت',
    'خالص', 'معلش', 'ده', 'دي', 'دا', 'اهو', 'حاجه', 'النهارده', 'امبارح',
    'عاوزين', 'عايزين', 'ماشي',
  ],
  gulf: [
    'وش', 'شلون', 'شنو', 'وين', 'ابغى', 'ابي', 'يبغى', 'وايد', 'زين', 'زينه',
    'مب', 'چذي', 'جذي', 'عندج', 'عليج', 'فيج', 'هني', 'هسه', 'يبا', 'تبا',
    'اشوف', 'شفيك', 'چم', 'ترى', 'تري', 'خوش', 'ابغي', 'شخبارك', 'مشكوره',
  ],
  levantine: [
    'شو', 'ليش', 'هلق', 'هيك', 'منيح', 'كتير', 'بدي', 'بدك', 'بدو', 'بدها',
    'هون', 'لهون', 'هلأ', 'مشان', 'كرمال', 'شقد', 'قديش', 'عنجد', 'مبلا',
    'لسه', 'عنجاد', 'كيفك', 'شلونك',
  ],
};

// Compile each marker as a standalone Arabic word: not preceded or followed by
// another Arabic letter, so "عم" doesn't fire inside "عمليه" and "زي" not inside
// "زيت". Markers are normalized so their spelling lines up with normalized text.
function compileDialectMarkers(words) {
  return words.map((word) => {
    const key = normalize(word, 'ar').trim();
    return new RegExp(`(?<![؀-ۿ])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![؀-ۿ])`);
  });
}
const DIALECT_MARKERS = {
  egyptian: compileDialectMarkers(DIALECT_MARKER_WORDS.egyptian),
  gulf: compileDialectMarkers(DIALECT_MARKER_WORDS.gulf),
  levantine: compileDialectMarkers(DIALECT_MARKER_WORDS.levantine),
};

// Returns 'egyptian' | 'gulf' | 'levantine' when one dialect clearly dominates
// the message, else null (generic/MSA Arabic — no confident dialect). Only fires
// for Arabic text; caller should persist the last confident result on the
// session so short follow-ups keep the established dialect.
function detectDialect(text) {
  if (!text || detectLanguage(text) !== 'ar') return null;
  const value = normalize(String(text), 'ar');
  const scores = { egyptian: 0, gulf: 0, levantine: 0 };
  for (const [dialect, markers] of Object.entries(DIALECT_MARKERS)) {
    for (const re of markers) {
      if (re.test(value)) scores[dialect] += 1;
    }
  }
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const [dialect, score] of Object.entries(scores)) {
    if (score > bestScore) { best = dialect; bestScore = score; tie = false; }
    else if (score === bestScore && score > 0) { tie = true; }
  }
  return bestScore > 0 && !tie ? best : null;
}

function normalizeArabicDigits(text) {
  return String(text || '').replace(/[٠-٩]/g, (digit) => ARABIC_DIGITS[digit] || digit);
}

// Collapse emphatic letter-elongation ("beginerrr", "clearrrrly", frustrated
// typing) down to a single letter before any pattern match runs. A run of 3+
// of the same letter is never a real word in either language (double letters
// like "book"/"ll" stay untouched — this only fires on 3+), so it's a safe,
// blanket fix that keeps every \b-anchored keyword regex in the codebase from
// silently missing an elongated variant.
function collapseElongation(text) {
  return text.replace(/([a-zA-Z؀-ۿ])\1{2,}/g, '$1');
}

function normalize(text, lang) {
  if (!text) return '';

  let value = normalizeArabicDigits(String(text)).trim();
  value = value.replace(/\s+/g, ' ');
  value = collapseElongation(value);

  if (lang === 'ar') {
    value = value
      .replace(/[\u064B-\u065F\u0670]/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/[ىئ]/g, 'ي')
      .replace(/ؤ/g, 'و');

    return value.toLowerCase();
  }

  return value.toLowerCase();
}

function tokenize(text) {
  return String(text || '')
    .split(/[\s,،.!?؟:/\\()[\]{}"'-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

module.exports = {
  detectLanguage,
  detectDialect,
  normalize,
  normalizeArabicDigits,
  tokenize,
};
