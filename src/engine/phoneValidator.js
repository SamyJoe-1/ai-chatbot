'use strict';

const { normalizeArabicDigits } = require('./detector');

function validatePhone(input) {
  if (!input || typeof input !== 'string') {
    return { valid: false, normalized: null };
  }

  const clean = normalizeArabicDigits(input).replace(/[^\d+]/g, '');
  if (!clean) {
    return { valid: false, normalized: null };
  }

  const digits = clean.replace(/\D/g, '');

  if (digits.length < 6 || digits.length > 14 || /^(\d)\1+$/.test(digits)) {
    return { valid: false, normalized: null };
  }

  const normalized = clean.startsWith('+') ? clean : digits;
  return { valid: true, normalized };
}

module.exports = { validatePhone };