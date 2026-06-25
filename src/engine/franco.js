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

// Real English words franco recovery must NEVER rewrite. Without this, short
// English words collide phonetically with menu items (e.g. "do" -> "hot",
// matching Hot Chocolate). Franco/Arabizi tokens are not in this set.
const COMMON_ENGLISH = new Set([
  'the', 'a', 'an', 'i', 'you', 'we', 'they', 'he', 'she', 'it', 'me', 'my',
  'your', 'our', 'us', 'him', 'her', 'to', 'for', 'of', 'in', 'on', 'at', 'by',
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will', 'shall',
  'may', 'might', 'must', 'want', 'wants', 'need', 'needs', 'get', 'got',
  'give', 'take', 'make', 'like', 'please', 'pls', 'and', 'or', 'but', 'with',
  'not', 'yes', 'yeah', 'yep', 'no', 'nope', 'ok', 'okay', 'sure', 'hi',
  'hello', 'hey', 'thanks', 'thank', 'bye', 'goodbye', 'what', 'whats',
  'which', 'how', 'when', 'where', 'why', 'who', 'this', 'that', 'these',
  'those', 'there', 'here', 'see', 'show', 'tell', 'find', 'know', 'help',
  'open', 'close', 'closed', 'hours', 'wifi', 'parking', 'price', 'cost',
  'menu', 'order', 'table', 'book', 'booking', 'reserve', 'available',
  'today', 'tomorrow', 'now', 'free', 'any', 'some', 'all',
]);

// Optionally define a small dictionary for direct overrides
const FRANCO_DICT = {
  'هالو': 'hello',
  'هاي': 'hi',
  'اوكي': 'okay',
  'ثانكس': 'thanks',
  'اوردر': 'order',
  'وردر': 'order',
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

  // 1. Only process if it has Franco characters (Latin characters or digits)
  if (!/[a-zA-Z0-9]/.test(text)) {
    return text;
  }

  // 2. Direct dictionary matches first (for extreme shortcuts)
  let processedText = text;
  for (const [k, v] of Object.entries(FRANCO_DICT)) {
    processedText = processedText.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
  }

  const { ARABIC_TO_ENGLISH_DICT } = require('./translation');
  const words = processedText.split(/[\s,،.!?؟:\/\\()[\]{}"'-]+/);
  
  // Helper: Transliterate Franco character-by-character to Arabic phonetic equivalent
  const francoToArabic = (w) => {
    let lowerW = w.toLowerCase();
    lowerW = lowerW.replace(/sh/g, 'ش');
    lowerW = lowerW.replace(/ch/g, 'ش');
    lowerW = lowerW.replace(/kh/g, 'خ');
    lowerW = lowerW.replace(/5/g, 'خ');
    lowerW = lowerW.replace(/gh/g, 'غ');
    lowerW = lowerW.replace(/3\'/g, 'غ');
    lowerW = lowerW.replace(/th/g, 'ث');
    lowerW = lowerW.replace(/3/g, 'ع');
    lowerW = lowerW.replace(/7/g, 'ح');
    lowerW = lowerW.replace(/2/g, 'ء');
    lowerW = lowerW.replace(/9/g, 'ص');
    lowerW = lowerW.replace(/6/g, 'ط');
    lowerW = lowerW.replace(/8/g, 'ق');

    const singleMap = {
      'a': 'ا', 'b': 'ب', 'p': 'ب', 't': 'ت', 'j': 'ج', 'g': 'ج', 'd': 'د',
      'r': 'ر', 'z': 'ز', 's': 'س', 'f': 'ف', 'v': 'ف', 'q': 'ق', 'k': 'ك',
      'c': 'ك', 'l': 'ل', 'm': 'م', 'n': 'ن', 'h': 'ه', 'w': 'و', 'o': 'و',
      'u': 'و', 'y': 'ي', 'i': 'ي', 'e': 'ي'
    };

    let result = '';
    for (let i = 0; i < lowerW.length; i++) {
      const char = lowerW[i];
      result += singleMap[char] || char;
    }
    return result;
  };

  // Helper: Normalize Arabic phonetic components to handle colloquial typos
  const arabicPhoneticNormalize = (t) => {
    if (!t) return '';
    return t
      .replace(/[طت]/g, 'ت')
      .replace(/[صسث]/g, 'س')
      .replace(/[حهه]/g, 'ه')
      .replace(/[كق]/g, 'ك')
      .replace(/[ذزظ]/g, 'ز')
      .replace(/[ضد]/g, 'د')
      .replace(/[أإآءؤئ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/[ىئ]/g, 'ي');
  };

  // Pre-build catalog Arabic words for mapping
  const catalogWords = [];
  if (items && items.length) {
    items.forEach(item => {
      [item.title_ar, item.category_ar, item.description_ar].forEach(field => {
        if (!field) return;
        field.split(/[\s,،.!?؟:\/\\()[\]{}"'-]+/).forEach(word => {
          const clean = word.trim();
          if (clean.length >= 2) {
            catalogWords.push({ ar: clean, en: item.title_en.split(' ')[0].toLowerCase() });
          }
        });
      });
    });
  }

  const recoveredWords = words.map(w => {
    if (w.length < 2) return w;
    const lowerW = w.toLowerCase();

    // Never rewrite a legitimate English word (prevents "do" -> "hot").
    if (COMMON_ENGLISH.has(lowerW)) return w;

    // Direct overrides
    const directDict = {
      'hello': 'hello', 'hi': 'hi', 'okay': 'okay', 'thanks': 'thanks',
      'order': 'order', 'shokran': 'thanks', 'salam': 'hi',
    };
    if (directDict[lowerW]) {
      return directDict[lowerW];
    }

    // A. Try character-by-character Arabic phonetic recovery mapping
    const arText = francoToArabic(lowerW);
    const normalizedArText = arabicPhoneticNormalize(arText);

    // Look up in translation dictionary first
    let bestArKey = null;
    let bestDist = 999;
    for (const arKey of Object.keys(ARABIC_TO_ENGLISH_DICT)) {
      const normalizedKey = arabicPhoneticNormalize(arKey);
      const dist = levenshtein(normalizedArText, normalizedKey);
      const minLen = Math.min(normalizedArText.length, normalizedKey.length);
      // Require an EXACT match for very short transliterations (<=3 chars).
      // A 1-edit budget there lets gibberish fragments collide with real words
      // (e.g. "hav" -> "هاف" matching "هاش"/hash). Longer words keep their budget.
      const maxAllowed = minLen <= 3 ? 0 : (minLen <= 4 ? 1 : 2);
      if (dist < bestDist && dist <= maxAllowed) {
        bestArKey = arKey;
        bestDist = dist;
      }
    }
    if (bestArKey) {
      return ARABIC_TO_ENGLISH_DICT[bestArKey];
    }

    // Look up in catalog Arabic words next
    let bestCatalogEnWord = null;
    let bestCatalogDist = 999;
    for (const entry of catalogWords) {
      const normalizedEntry = arabicPhoneticNormalize(entry.ar);
      const dist = levenshtein(normalizedArText, normalizedEntry);
      const minLen = Math.min(normalizedArText.length, normalizedEntry.length);
      // Same exact-match guard for short transliterations as the dict loop above.
      const maxAllowed = minLen <= 3 ? 0 : (minLen <= 4 ? 1 : 2);
      if (dist < bestCatalogDist && dist <= maxAllowed) {
        bestCatalogEnWord = entry.en;
        bestCatalogDist = dist;
      }
    }
    if (bestCatalogEnWord) {
      return bestCatalogEnWord;
    }

    // B. Fallback to existing phoneticHash matching (collapsing digraphs/consonants)
    const wHash = phoneticHash(lowerW);
    if (!wHash) return w;

    const vocabList = buildPhoneticVocabularyList(items || []);
    let bestMatch = null;
    let bestScore = 999;
    let bestStrDist = 999;

    for (const v of vocabList) {
      if (!v.hash) continue;

      const dist = levenshtein(wHash, v.hash);
      if (dist === 0) {
        // Prevent collisions on very short hashes (e.g. length <= 2 like "N").
        // Require near-identical spelling (<=1 edit) — a 2-edit budget on a tiny
        // hash lets unrelated 3-letter fragments collide with menu words.
        if (wHash.length <= 2) {
          const strDist = levenshtein(lowerW, v.word);
          if (strDist <= 1) {
            return v.word;
          }
        } else {
          return v.word;
        }
      }

      // Allow distance 1 only for hashes of length >= 3 and with close string distance
      if (dist === 1 && wHash.length >= 3 && v.hash.length >= 3) {
        const strDist = levenshtein(lowerW, v.word);
        const maxStrAllowed = Math.min(lowerW.length, v.word.length) <= 4 ? 1 : 2;
        if (strDist <= maxStrAllowed) {
          if (dist < bestScore || (dist === bestScore && strDist < bestStrDist)) {
            bestMatch = v.word;
            bestScore = dist;
            bestStrDist = strDist;
          }
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
