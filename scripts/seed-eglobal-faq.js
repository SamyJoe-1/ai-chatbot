'use strict';

// Seed the sourcing FAQ (EN + AR) for the E-global brand.
//
//   node scripts/seed-eglobal-faq.js            # matches a business whose name contains "global"
//   node scripts/seed-eglobal-faq.js "E-global" # match by name substring (case-insensitive)
//   node scripts/seed-eglobal-faq.js 7          # match by exact business id
//
// Safe to re-run: it MERGES — only FAQ entries whose question isn't already
// present (case-insensitive) are appended, so existing FAQs are never lost.

const path = require('path');
// Make the default DB path (process.cwd()/data/chatbot.db) resolve correctly no
// matter where this is launched from.
process.chdir(path.join(__dirname, '..'));
const db = require('../src/db/db');

const FAQ_EN = [
  { q: 'what is the wholesale price', a: "Wholesale pricing depends on the quantity you need. Send us the quantity you're after and we'll get you the best available quote." },
  { q: 'what quantity is available', a: "Quantity depends on the supplier's stock, and in most cases we can provide the amounts you need. Contact us to check current availability." },
  { q: 'do you offer samples', a: "That depends on the supplier's policy — some suppliers provide samples before fulfilling large bulk orders." },
  { q: 'from how many pieces does the wholesale price start', a: 'The minimum order quantity varies by product type and supplier policy, and it will be clarified for you when you request a quote.' },
  { q: 'do you ship to all regions in saudi arabia', a: 'Yes, we ship to all regions of Saudi Arabia through approved shipping partners, depending on the product type and delivery location.' },
  { q: 'do you give discounts for bulk quantities', a: "Yes, prices usually drop as the requested quantity increases, and we'll negotiate with the supplier to get you the best possible price." },
  { q: 'can i order from more than one gulf country', a: "Yes, you can request products available in more than one Gulf country, and we'll coordinate the order and provide the best options. Contact us directly to arrange it." },
];

const FAQ_AR = [
  { q: 'كم سعر الجملة', a: 'يختلف سعر الجملة حسب الكمية المطلوبة. أرسل لنا الكمية التي تحتاجها وسنقدم لك أفضل عرض سعر متاح.' },
  { q: 'ما الكمية المتوفرة', a: 'تعتمد الكمية على مخزون المورد، ويمكننا توفير الكميات المطلوبة في معظم الحالات. تواصل معنا لمعرفة التوفر الحالي.' },
  { q: 'هل يوجد عينات', a: 'يعتمد ذلك على سياسة المورد، حيث يوفر بعض الموردين عينات قبل تنفيذ طلبات الكميات الكبيرة.' },
  { q: 'من كم قطعة يبدأ سعر الجملة', a: 'يختلف الحد الأدنى للطلب حسب نوع المنتج وسياسة المورد، وسيتم توضيحه لك عند طلب عرض السعر.' },
  { q: 'هل توفرون الشحن لكل مناطق السعودية', a: 'نعم، نوفر الشحن إلى جميع مناطق المملكة العربية السعودية من خلال شركاء الشحن المعتمدين، حسب نوع المنتج وموقع التسليم.' },
  { q: 'هل تقدمون خصومات للكميات الكبيرة', a: 'نعم، غالبًا ما تنخفض الأسعار كلما زادت الكمية المطلوبة، وسنعمل على التفاوض مع المورد للحصول على أفضل سعر ممكن.' },
  { q: 'هل أطلب من أكثر من دولة خليجية', a: 'نعم، يمكنك طلب منتجات متوفرة في أكثر من دولة خليجية، وسنقوم بتنسيق الطلب وتوفير أفضل الخيارات. تواصل معنا مباشرة لتنسيق الطلب.' },
];

function parseFaq(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Merge new entries into existing, keyed on the trimmed/lowercased question.
function mergeFaq(existing, additions) {
  const seen = new Set(existing.map((e) => String(e.q || e.question || '').trim().toLowerCase()));
  const merged = existing.slice();
  let added = 0;
  for (const entry of additions) {
    const key = entry.q.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ q: entry.q, a: entry.a });
    added += 1;
  }
  return { merged, added };
}

function resolveBusiness(arg) {
  if (arg && /^\d+$/.test(arg)) {
    const row = db.prepare('SELECT * FROM businesses WHERE id = ?').get(Number(arg));
    return row ? [row] : [];
  }
  const needle = `%${(arg || 'global').toLowerCase()}%`;
  return db.prepare('SELECT * FROM businesses WHERE lower(name) LIKE ? OR lower(name_ar) LIKE ?').all(needle, needle);
}

function main() {
  const arg = process.argv[2];
  const matches = resolveBusiness(arg);

  if (matches.length === 0) {
    console.error(`No business matched "${arg || 'global'}". Available businesses:`);
    db.prepare('SELECT id, name, service_type FROM businesses ORDER BY id').all()
      .forEach((b) => console.error(`  #${b.id}  ${b.name}  (${b.service_type})`));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`"${arg || 'global'}" matched ${matches.length} businesses — re-run with the exact id:`);
    matches.forEach((b) => console.error(`  #${b.id}  ${b.name}  (${b.service_type})`));
    process.exit(1);
  }

  const business = matches[0];
  const en = mergeFaq(parseFaq(business.faq_en), FAQ_EN);
  const ar = mergeFaq(parseFaq(business.faq_ar), FAQ_AR);

  db.prepare('UPDATE businesses SET faq_en = ?, faq_ar = ? WHERE id = ?')
    .run(JSON.stringify(en.merged), JSON.stringify(ar.merged), business.id);
  db.checkpoint();

  console.log(`Updated FAQ for #${business.id} "${business.name}" (${business.service_type}).`);
  console.log(`  EN: +${en.added} added (${en.merged.length} total)`);
  console.log(`  AR: +${ar.added} added (${ar.merged.length} total)`);
  console.log('FAQ is read fresh per message, so no restart is needed for it to take effect.');
}

main();
