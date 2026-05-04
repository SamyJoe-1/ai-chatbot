'use strict';

const ARABIC_REGEX = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/g;
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
  const compact = text.replace(/\s/g, '');
  if (!compact) return 'en';
  const arabicCount = (compact.match(ARABIC_REGEX) || []).length;
  return arabicCount / compact.length >= 0.2 ? 'ar' : 'en';
}

function normalizeArabicDigits(text) {
  return text.replace(/[٠-٩]/g, (digit) => ARABIC_DIGITS[digit] || digit);
}

function normalize(text, lang) {
  if (!text) return '';
  let value = normalizeArabicDigits(String(text)).trim();
  value = value.replace(/\s+/g, ' ');

  if (lang === 'ar') {
    value = value
      .replace(/[\u064b-\u065f\u0670]/g, '')
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
  normalize,
  normalizeArabicDigits,
  tokenize,
};
