'use strict';

const { phone } = require('phone');
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
  if (digits.length < 8 || /^(\d)\1+$/.test(digits)) {
    return { valid: false, normalized: null };
  }

  if (clean.startsWith('+')) {
    const intlResult = phone(clean);
    if (intlResult.isValid) {
      return { valid: true, normalized: intlResult.phoneNumber };
    }
    return { valid: false, normalized: null };
  }

  if (digits.startsWith('20')) {
    const egyptIntlResult = phone(`+${digits}`);
    if (egyptIntlResult.isValid) {
      return { valid: true, normalized: egyptIntlResult.phoneNumber };
    }
  }

  const egyptResult = phone(clean, { country: 'EGY' });
  if (egyptResult.isValid) {
    return { valid: true, normalized: egyptResult.phoneNumber };
  }

  return { valid: false, normalized: null };
}

module.exports = { validatePhone };
