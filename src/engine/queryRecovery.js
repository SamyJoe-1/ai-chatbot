'use strict';

const { getBusinessItems } = require('../brains/shared/catalogStore');
const { normalize, tokenize } = require('./detector');

const COMMON_ENGLISH_TERMS = [
  'project',
  'projects',
  'property',
  'properties',
  'listing',
  'listings',
  'unit',
  'units',
  'price',
  'location',
  'specs',
  'payment',
  'compound',
  'villa',
  'apartment',
  'office',
  'clinic',
  'mall',
  'tower',
  'suite',
  'suites',
  'residential',
  'commercial',
  'administrative',
  'medical',
  'rental',
  'investment',
];

function levenshtein(a, b) {
  const source = String(a || '');
  const target = String(b || '');
  if (source === target) return 0;
  if (!source.length) return target.length;
  if (!target.length) return source.length;

  const rows = Array.from({ length: source.length + 1 }, () => new Array(target.length + 1).fill(0));
  for (let i = 0; i <= source.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= target.length; j += 1) rows[0][j] = j;

  for (let i = 1; i <= source.length; i += 1) {
    for (let j = 1; j <= target.length; j += 1) {
      const cost = source[i - 1] === target[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost
      );
    }
  }

  return rows[source.length][target.length];
}

function similarity(a, b) {
  const source = String(a || '');
  const target = String(b || '');
  if (!source && !target) return 1;
  const maxLength = Math.max(source.length, target.length);
  if (!maxLength) return 1;
  return 1 - (levenshtein(source, target) / maxLength);
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildVocabulary(items, lang) {
  const rawWords = [];
  items.forEach((item) => {
    [
      item.title_en,
      item.title_ar,
      item.category_en,
      item.category_ar,
      item.description_en,
      item.description_ar,
      item.metadata?.listing_type,
      item.metadata?.asset_type,
      item.metadata?.unit_type,
      item.metadata?.offer_type,
      item.metadata?.project_name,
      item.metadata?.compound,
      item.metadata?.district,
      item.metadata?.location,
    ].forEach((value) => {
      tokenize(normalize(String(value || ''), lang)).forEach((token) => {
        if (token.length >= 3) rawWords.push(token);
      });
    });
  });

  if (lang === 'en') {
    rawWords.push(...COMMON_ENGLISH_TERMS);
  }

  return unique(rawWords);
}

function shouldReplaceToken(token, candidate, lang) {
  if (!token || !candidate || token === candidate) return false;
  if (lang !== 'en') return false;
  if (token.length < 4) return false;
  if (/^\d+$/.test(token)) return false;
  if (token[0] !== candidate[0]) return false;

  const distance = levenshtein(token, candidate);
  if (token.length <= 5) return distance <= 1;
  if (token.length <= 8) return distance <= 2;
  return distance <= 3;
}

function correctEnglishTokens(text, vocabulary) {
  return tokenize(text).map((token) => {
    const normalizedToken = normalize(token, 'en');
    if (!normalizedToken || vocabulary.includes(normalizedToken) || normalizedToken.length < 4) {
      return token;
    }

    let best = null;
    let bestScore = 0;
    vocabulary.forEach((candidate) => {
      if (!shouldReplaceToken(normalizedToken, candidate, 'en')) return;
      const score = similarity(normalizedToken, candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });

    return best && bestScore >= 0.72 ? best : token;
  }).join(' ');
}

function buildPhraseCandidates(items) {
  const phrases = [];
  items.forEach((item) => {
    [
      item.title_en,
      item.title_ar,
      item.category_en,
      item.category_ar,
      item.metadata?.project_name,
      item.metadata?.compound,
      item.metadata?.asset_type,
      item.metadata?.unit_type,
    ].forEach((value) => {
      const phrase = String(value || '').trim();
      if (phrase) phrases.push(phrase);
    });
  });
  return unique(phrases);
}

function findClosestPhrase(text, lang, items) {
  const normalizedText = normalize(text, lang);
  const textTokens = tokenize(normalizedText);
  if (!normalizedText || !textTokens.length) return null;

  let best = null;
  let bestScore = 0;

  buildPhraseCandidates(items).forEach((candidate) => {
    const normalizedCandidate = normalize(candidate, lang);
    if (!normalizedCandidate || normalizedCandidate === normalizedText) return;

    const candidateTokens = tokenize(normalizedCandidate);
    const overlap = textTokens.filter((token) => candidateTokens.includes(token)).length;
    const overlapRatio = overlap / Math.max(textTokens.length, candidateTokens.length, 1);
    const phraseSimilarity = similarity(normalizedText, normalizedCandidate);
    const score = (overlapRatio * 0.55) + (phraseSimilarity * 0.45);

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  });

  if (!best) return null;

  if (lang === 'ar' && bestScore >= 0.58) return best;
  if (lang === 'en' && bestScore >= 0.64) return best;
  return null;
}

function recoverUserQuery(text, lang, businessId) {
  const items = getBusinessItems(businessId);
  if (!items.length) return null;

  const sourceText = String(text || '').trim();
  if (!sourceText) return null;

  const normalizedLang = lang === 'ar' ? 'ar' : 'en';
  const vocabulary = buildVocabulary(items, normalizedLang);
  const tokenCorrected = normalizedLang === 'en'
    ? correctEnglishTokens(sourceText, vocabulary)
    : sourceText;

  const closestPhrase = findClosestPhrase(tokenCorrected, normalizedLang, items);
  if (closestPhrase) {
    return closestPhrase;
  }

  const normalizedOriginal = normalize(sourceText, normalizedLang);
  const normalizedCorrected = normalize(tokenCorrected, normalizedLang);
  if (normalizedCorrected && normalizedCorrected !== normalizedOriginal) {
    return tokenCorrected;
  }

  return null;
}

module.exports = {
  recoverUserQuery,
  levenshtein,
};
