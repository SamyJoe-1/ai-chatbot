'use strict';

const { levenshtein } = require('./queryRecovery');

const ARABIC_TO_ENGLISH_MAP = {
  'ا': 'a', 'أ': 'a', 'إ': 'e', 'آ': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z',
  'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'k', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'و': 'o', 'ي': 'y',
  'ة': 'a', 'ى': 'a', 'ئ': 'e', 'ؤ': 'o', 'ء': 'a'
};

function transliterateArToEn(text) {
  let result = '';
  for (let c of String(text || '')) {
    result += ARABIC_TO_ENGLISH_MAP[c] || c;
  }
  return result;
}

function phoneticHash(word) {
  if (!word) return '';
  let w = String(word).toLowerCase();
  
  // common digraphs and sounds
  w = w.replace(/ch/g, 'X');
  w = w.replace(/sh/g, 'X');
  w = w.replace(/th/g, 'T');
  w = w.replace(/ph/g, 'F');
  w = w.replace(/kh/g, 'K');
  w = w.replace(/gh/g, 'G');
  
  // map to phonetic buckets
  const bucketMap = {
    'b': 'B', 'p': 'B', 'f': 'F', 'v': 'F',
    'c': 'K', 'k': 'K', 'q': 'K', 'g': 'K',
    's': 'S', 'z': 'S', 'x': 'S',
    'd': 'T', 't': 'T',
    'm': 'N', 'n': 'N',
    'r': 'L', 'l': 'L',
    'w': '', 'y': '', 'h': '', 'j': 'G',
    'a': '', 'e': '', 'i': '', 'o': '', 'u': ''
  };
  
  let hash = '';
  for (let c of w) {
    if (c === 'X') hash += 'X';
    else if (bucketMap[c] !== undefined) hash += bucketMap[c];
    else hash += c;
  }
  
  // collapse consecutive duplicates (e.g. SS -> S)
  return hash.replace(/(.)\1+/g, '$1');
}

// Optionally define a small dictionary for direct overrides
const FRANCO_DICT = {
  'هالو': 'hello',
  'هاي': 'hi',
  'اوكي': 'okay',
  'ثانكس': 'thanks',
};

function buildPhoneticVocabularyList(items) {
  const list = [];
  const seen = new Set();
  
  const addWord = (w) => {
    const clean = w.toLowerCase().replace(/[^a-z]/g, '');
    if (clean.length < 3 && clean !== 'hi') return;
    if (seen.has(clean)) return;
    
    seen.add(clean);
    list.push({ word: clean, hash: phoneticHash(clean) });
  };
  
  items.forEach(item => {
    [item.title_en, item.category_en, item.description_en].forEach(field => {
      if (!field) return;
      field.split(/[\s,،.!?؟:\/\\()[\]{}"'-]+/).forEach(addWord);
    });
  });
  
  ['hello', 'hi', 'menu', 'price', 'location', 'thanks', 'help', 'booking', 'reservation'].forEach(addWord);
  
  return list;
}

function recoverFranco(text, items) {
  if (!text) return text;
  
  // 1. Direct dictionary matches first (for extreme shortcuts)
  let processedText = text;
  for (const [k, v] of Object.entries(FRANCO_DICT)) {
    processedText = processedText.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
  }

  // 2. Transliterate AR -> EN phonetics
  const arToEnText = transliterateArToEn(processedText);
  const words = arToEnText.split(/[\s,،.!?؟:\/\\()[\]{}"'-]+/);
  const vocabList = buildPhoneticVocabularyList(items);
  
  // 3. Match each transliterated word's phonetic hash against the catalog's phonetic hashes
  const recoveredWords = words.map(w => {
    if (w.length < 2) return w;
    const wHash = phoneticHash(w);
    if (!wHash) return w;
    
    let bestMatch = null;
    let bestScore = 999;
    let bestStrDist = 999;
    
    for (const v of vocabList) {
      if (!v.hash) continue;
      
      const dist = levenshtein(wHash, v.hash);
      
      if (dist === 0) {
        return v.word; // immediate perfect phonetic match
      }
      
      // Allow distance 1 for hashes of sufficient length
      if (dist === 1 && wHash.length >= 1 && v.hash.length >= 1) {
        const strDist = levenshtein(w, v.word);
        if (dist < bestScore || (dist === bestScore && strDist < bestStrDist)) {
            bestMatch = v.word;
            bestScore = dist;
            bestStrDist = strDist;
        }
      }
    }
    
    return bestMatch ? bestMatch : w;
  });
  
  return recoveredWords.join(' ').trim();
}

module.exports = {
  recoverFranco,
  phoneticHash,
  transliterateArToEn
};
