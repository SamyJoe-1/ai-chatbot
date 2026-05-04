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

  let result = phone(clean);
  if (result.isValid) {
    return { valid: true, normalized: result.phoneNumber };
  }

  result = phone(clean, { country: 'EGY' });
  if (result.isValid) {
    return { valid: true, normalized: result.phoneNumber };
  }

  const digits = clean.replace(/\D/g, '');
  if (clean.startsWith('+') && digits.length >= 10 && digits.length <= 15) {
    return { valid: true, normalized: clean };
  }

  return { valid: false, normalized: null };
}

module.exports = { validatePhone };
