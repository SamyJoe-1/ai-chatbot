'use strict';

/**
 * LIVE end-to-end run of the 14 client-feedback scenarios against the real
 * HTTP API (server must be running on :3500). Each scenario gets a fresh
 * session (name/phone onboarding included) so context can't leak between
 * tests — except the scenarios that deliberately test context carry-over.
 *
 * Run: node scripts/e2e-client-feedback.js
 */

const BASE = process.env.CHAT_BASE || 'http://localhost:3500';
const TOKEN = process.env.CHAT_TOKEN || '5b110491b1d54faf90c946a638a819c0';

let passed = 0;
let failed = 0;

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bot-token': TOKEN },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function newSession() {
  const init = await api('/api/init', { force_new: true });
  const key = init.session_key;
  // Onboard: name then phone.
  await api('/api/message', { session_key: key, message: 'احمد التاجر' });
  await api('/api/message', { session_key: key, message: '01012345678' });
  return key;
}

async function send(key, message) {
  const out = await api('/api/message', { session_key: key, message });
  const r = out.response || {};
  const text = [r.text, ...(Array.isArray(r.messages) ? r.messages.map((m) => m.text) : [])]
    .filter(Boolean).join('\n');
  return { intent: out.intent, text, suggestions: r.suggestions || [], raw: out };
}

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}`);
    if (detail) console.log(`    ${String(detail).replace(/\n/g, ' | ').slice(0, 300)}`);
  }
}

(async () => {
  // 1 — company intro
  {
    const k = await newSession();
    const r = await send(k, 'ممكن تعرفني بشركتكم ومجال عملكم؟');
    check('1. تعريف بالشركة → توريد + منتجات', /توريد|Sourcing/i.test(r.text) && /منتجات/.test(r.text), `[${r.intent}] ${r.text}`);
  }

  // 2 + 2b — bare country browse asks category, then chip shows products
  {
    const k = await newSession();
    const r = await send(k, 'ما هي المنتجات المتاحة لديكم في السعودية؟');
    check('2. منتجات السعودية → يسأل الفئة', r.intent === 'ecommerce_country_categories' && /الفئة|القسم/.test(r.text), `[${r.intent}] ${r.text}`);
    const r2 = await send(k, 'الجمال والعناية');
    check('2b. اختيار الفئة → منتجات سعودية', r2.intent === 'ecommerce_country_products' && /نعم/.test(r2.text) && /السعودية/.test(r2.text), `[${r2.intent}] ${r2.text}`);
  }

  // 4 — perfumes not hijacked by stale context item
  {
    const k = await newSession();
    await send(k, 'منظم مستلزمات الأطفال'); // puts the baby organizer in context
    const r = await send(k, 'هل متوفر عطور؟');
    const mentionsBaby = /منظم|أطفال/.test(r.text) && !/عطر/.test(r.text);
    check('4. هل متوفر عطور؟ → عطور وليس منتج قديم', !mentionsBaby && /عطر|عطور|برفيوم|ديور|Perfume/i.test(r.text), `[${r.intent}] ${r.text}`);
  }

  // 5 — categories scoped to KSA
  {
    const k = await newSession();
    const r = await send(k, 'ما هي أقسام المنتجات لديكم في السعودية؟');
    check('5. أقسام السعودية فقط', r.intent === 'faq' ? false : (/السعودية/.test(r.text) && !/أجهزة منزلية/.test(r.text) && /الجمال|العطور/.test(r.text)), `[${r.intent}] ${r.text}`);
  }

  // 6 — hair products in Iraq
  {
    const k = await newSession();
    const r = await send(k, 'منتجات للشعر في العراق');
    check('6. شعر في العراق → Res Q hair', /Res Q|الشعر/.test(r.text) && !/بشرة|لوشن فازلين/.test(r.text.split('\n')[0]) && /نعم/.test(r.text), `[${r.intent}] ${r.text}`);
  }

  // 7 — availability framing
  {
    const k = await newSession();
    const r = await send(k, 'منتجات الشعر في السعودية');
    check('7. يبدأ بـ نعم متوفر', /^نعم/.test(r.text.trim()), `[${r.intent}] ${r.text}`);
  }

  // 8 — price threshold
  {
    const k = await newSession();
    const r = await send(k, 'هل متوفر لديكم منتجات بأقل من 50 ريال؟');
    check('8. أقل من 50 ريال → لا تصفية بالسعر', r.intent === 'ecommerce_price_filter' && !/سيروم/.test(r.text), `[${r.intent}] ${r.text}`);
  }

  // 9 — Libya products directly
  {
    const k = await newSession();
    const r = await send(k, 'ما هي منتجاتكم في ليبيا؟');
    check('9. ليبيا → عرض المنتجات مباشرة', r.intent === 'ecommerce_country_products' && /نعم/.test(r.text), `[${r.intent}] ${r.text}`);
  }

  // 10 — women's perfume in Kuwait: honest miss, no Libya product shown as if
  // it were the answer (naming Libya in the "also available in" note is fine).
  {
    const k = await newSession();
    const r = await send(k, 'هل متاح عطر نسائي في الكويت؟');
    const withoutElsewhereNote = r.text.replace(/[^\n]*متوفر لدينا حالياً في[^\n]*/g, '');
    check('10. عطر نسائي الكويت → لا منتجات ليبيا',
      !/ليبيا/.test(withoutElsewhereNote) && /الكويت/.test(r.text) && /نسائي/.test(r.text),
      `[${r.intent}] ${r.text}`);
  }

  // 11 — home appliances in Qatar: honest miss + Qatar alternatives
  {
    const k = await newSession();
    const r = await send(k, 'هل متاح أجهزة منزلية في قطر؟');
    check('11. أجهزة منزلية قطر → غير متوفر + بدائل قطر', r.intent === 'ecommerce_country_miss' && /غير متوفر/.test(r.text) && /قطر/.test(r.text), `[${r.intent}] ${r.text}`);
  }

  // 13 — exact code lookup
  {
    const k = await newSession();
    const r = await send(k, 'SA-BC1004 هل هذا المنتج ما زال متوفر لديكم؟');
    check('13. SA-BC1004 → نفس الكود بالضبط', r.intent === 'ecommerce_code_lookup' && /SA-BC1004/.test(r.text) && /نعم/.test(r.text), `[${r.intent}] ${r.text}`);
  }

  // 14 — bare code in Arabic session answers in Arabic; unknown code honest
  {
    const k = await newSession();
    await send(k, 'مرحبا'); // establish Arabic session language
    const r = await send(k, 'QT-BC1001');
    check('14a. QT-BC1001 → عربي + الكود الصحيح', /[؀-ۿ]/.test(r.text) && /QT-BC1001/.test(r.text) && /نعم/.test(r.text), `[${r.intent}] ${r.text}`);
    const r2 = await send(k, 'XX-ZZ9999');
    check('14b. كود مجهول → غير موجود في قاعدة البيانات', r2.intent === 'ecommerce_code_not_found' && /قاعدة بيانات/.test(r2.text) && /[؀-ۿ]/.test(r2.text), `[${r2.intent}] ${r2.text}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('E2E crashed:', e);
  process.exit(1);
});
