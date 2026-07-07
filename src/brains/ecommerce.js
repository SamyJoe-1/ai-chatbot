'use strict';

const { tokenize, normalize } = require('../engine/detector');
const { getBusinessItems, getAllBusinessItems } = require('./shared/catalogStore');
const { findMatchingCategories, findScoredItems, uniqueById, uniqueScoredByTitle, detectCountry, detectCountries, detectAnyKnownCountry, countryCanonicalId, countryMatchesItem } = require('./shared/matcher');
const { getItemThumbnail, buildThumbnailMessages } = require('./shared/thumbnailMessages');
const { matchFaq } = require('../engine/faqMatcher');

const FEATURE_SYNONYMS = {
  color: ['color', 'colors', 'لون', 'اللون', 'ألوان', 'الوان'],
  material: ['material', 'materials', 'مادة', 'خامة', 'المادة', 'الخامة', 'صنع من'],
  dimensions: ['dimensions', 'dimension', 'size', 'sizes', 'أبعاد', 'ابعاد', 'الحجم', 'حجم', 'مقاس', 'مقاسات'],
  weight: ['weight', 'الوزن', 'وزن'],
  shipping: ['shipping', 'delivery', 'شحن', 'الشحن', 'التوصيل', 'توصيل'],
  country: ['country', 'origin', 'بلد', 'البلد', 'دولة', 'الدولة', 'منشأ', 'المنشأ'],
  code: ['sku', 'code', 'كود', 'الكود', 'رقم المنتج'],
};

const FEATURE_LABELS = {
  en: {
    color: 'Color',
    material: 'Material',
    dimensions: 'Dimensions',
    weight: 'Weight',
    shipping: 'Shipping',
    country: 'Country of Origin',
    code: 'Product Code',
  },
  ar: {
    color: 'اللون',
    material: 'الخامة / المادة',
    dimensions: 'الأبعاد / المقاس',
    weight: 'الوزن',
    shipping: 'الشحن',
    country: 'بلد المنشأ',
    code: 'كود المنتج',
  }
};

// Marketing badges that ship inside metadata.badge ("new", "trending", ...). The
// hot_selling boolean is handled separately (ecommerce_search_hot); these are the
// curated badge filters a customer asks for ("what's new", "limited products").
const BADGE_SYNONYMS = {
  trending: ['trending', 'trend', 'رائج', 'رائجة', 'الرائج', 'تريند', 'الترند'],
  new: ['new', 'newest', 'latest', 'just arrived', 'جديد', 'جديدة', 'الجديد', 'وصل حديثا', 'وصل حديثاً', 'الأحدث', 'الاحدث'],
  limited: ['limited', 'limited edition', 'محدود', 'محدودة', 'كمية محدودة', 'إصدار محدود'],
  offer: ['offer', 'offers', 'sale', 'discount', 'deal', 'عرض', 'عروض', 'خصم', 'تخفيض', 'تخفيضات'],
};

const PATTERNS = {
  en: {
    greeting_hello: [/^(hi|hello|hey|hiya|howdy)\b/i, /^good (morning|afternoon|evening)\b/i],
    greeting_how_are_you: [/^(how are u|how are u doing|are u okay|how are you|how are you doing|are you okay)\b/i],
    greeting_yasta: [/^(yasta)\b/i],
    thanks: [/\b(thanks|thank you|thx|ty|appreciate)\b/i],
    // A customer who explicitly has no idea what to buy ("help me choose",
    // "no experience", "where do I even start") needs to be walked through a
    // choice, not handed the generic capabilities blurb (`help`, below) or an
    // AI freeform reply asking them to restate what they already said they
    // don't know. Checked BEFORE `help` since these phrases often contain the
    // word "help" too.
    guided_discovery: [
      /\bhelp me choose\b/i,
      /\bhelp .*(choos|pick|decide)/i,
      /\b(don'?t|do not|dont) know (where to start|what to (choose|pick|get|buy))\b/i,
      /\bwhere (do|should) i (even )?start\b/i,
      /\b(from |even )?where to start\b/i,
      /\bknow nothing about\b/i,
      /\bno (idea|clue|experience)\b/i,
      /\bzero experience\b/i,
      /\bguide me\b/i,
      /\bwalk me through\b/i,
      /\bwhich (one|product) should i (choose|pick|get|buy)\b/i,
      /\bhow (do|should|can) i (choose|pick|decide)\b/i,
      /\bnew to (sourcing|this|buying|shopping)\b/i,
      /\bbased on what\b.*\bchoose\b/i,
      /\bnot sure (which|what|how) to (choose|pick)\b/i,
      /\bcan'?t decide\b/i,
      /\btips?\s*(and tricks)?\b.*\bbeginn?er/i,
      /\bbeginn?er\b.*\btips?\b/i,
      /\bany (tips|advice)\b/i,
      /\badvice for (beginners|newbies|starting out)\b/i,
      // Confusion / lost signals and "help me find" — the customer is asking
      // to be walked through a choice, not for the capabilities blurb.
      /\b(i'?m|i am|i feel|feeling|im) (a bit |so |really |kinda )?(confused|lost|overwhelmed|unsure)\b/i,
      /\bhelp me (find|look for|search)\b/i,
      /\bhelp\b.{0,25}\bfind (my|a|the right|me a) product\b/i,
      /\bfind (me )?(my|the right) product\b/i,
      /\bnot sure what (i|to)\b/i,
    ],
    help: [/\bhelp\b/i, /\bwhat can you do\b/i, /\bhow does this work\b/i],
    contact: [/\bcontact\b/i, /\bphone\b/i, /\bwhatsapp\b/i, /\bcall\b/i, /\bemail\b/i],
    working_hours: [/\bhours\b/i, /\bopen\b/i, /\bclose\b/i, /\bworking hours\b/i],
    location: [/\blocation\b/i, /\baddress\b/i, /\bwhere are you\b/i, /\bdirections\b/i],
    brand_info: [/\bwho are you\b/i, /\babout you\b/i, /\babout the store\b/i, /\bwhat do you provide\b/i],
    catalog_general: [/\bcatalog\b/i, /\bwhat do you have\b/i, /\bshow me\b/i],
    // Bare generic nouns — "marketplace"/"products" show up inside all kinds of
    // unrelated sentences ("not marketplace", "do you have products for SA in
    // this category") and would otherwise hijack them into the canned browse
    // reply. Only trust a bare hit when it's the CORE of a short message —
    // see the length gate at the call site.
    catalog_general_generic: [/\bmarketplace\b/i, /\bproducts\b/i],
    // Enumerating ALL categories ("what categories do you have", "list the
    // categories") is distinct from ecommerce_category_info, which only fires
    // once a SPECIFIC known category is already matched in the text. This one
    // is answered straight from the local catalog — no AI call needed.
    list_categories: [
      /\b(all |the )?categories\b/i,
      /\bwhat (categories|sections|departments)\b/i,
      /\blist (the )?categories\b/i,
      /\bcategories (do you have|are there|are available)\b/i,
    ],
    order_howto: [/\bhow (do|can|could|would|to)\b[\w\s]{0,20}\border\b/i, /\bhow does ordering work\b/i, /\bhow to (place|make) an order\b/i],
    ecommerce_search_hot: [/\bhot\b/i, /\bbest selling\b/i, /\bbest-selling\b/i, /\bbestseller\b/i, /\bpopular\b/i, /\btop selling\b/i],
    ecommerce_category_info: [/\bcategory\b/i, /\bmore about\b/i, /\bdetails on\b/i],
    ecommerce_product_advantages: [/\badvantages\b/i, /\bbenefits\b/i, /\bwhy choose\b/i, /\bfeatures\b/i],
    // Context follow-up: "tell me more about it", "more details", "more info".
    // Resolves against the product already in context (last_item).
    more_details: [
      /\b(tell|show|give) me more\b/i,
      /\bmore (details?|info|information)\b/i,
      /\b(details?|info|information) (about|on) (it|this|that)\b/i,
      /\btell me (about|more about) (it|this|that)\b/i,
      /\bwhat (else|more) (can you tell|about it)\b/i,
    ],
    ecommerce_check_availability: [/\bavailability\b/i, /\bavailable\b/i, /\bin stock\b/i],
    // "which countries do you serve / do you ship to X / where do you operate" —
    // a SERVICE-AREA question (not opening hours, not a product filter). Kept
    // ahead of working_hours in detectIntent so "do you work in Morocco" never
    // gets answered with business hours.
    service_area: [
      /\b(which|what) countr(y|ies)\b/i,
      /\bcountries (do|are) you\b/i,
      /\bdo you (work|operate|sell|ship|deliver|serve|source|export|cover|reach|have anything)\s+(in|to|from|out)\b/i,
      /\bdo you (ship|deliver|export)\s+(to|internationally|abroad|worldwide)\b/i,
      /\bwhere (do|are) you (operate|operating|based|located|ship|shipping|work|working|source|sourcing)\b/i,
      /\b(work|operate|available|present|sell|ship)\s+in\s+(which|what)\s+countr/i,
    ],
    // Verb of presence/operation — combined with a recognized country name to
    // catch "do you work in <specific country>" even when the generic patterns
    // above don't fire.
    service_area_verb: [/\b(work|operate|sell|ship|deliver|serve|source|export|present|available|based|located|reach)\b/i],
    business_model: [/\b(drop\s?shipping|drop\s?ship|wholesale|reseller|reselling|bulk (order|supply|supplier)|affiliate|distributor|distribution|do you supply)\b/i],
    ecommerce_country_info: [/\bmarketplace in\b/i, /\babout country\b/i, /\bcountry\b/i],
    ecommerce_country_products: [/\bproducts in\b/i, /\bfrom country\b/i, /\bmarketplace in\b/i, /\bin the country\b/i],
    // "send me one product", "just one", "one fuckin product" — the customer
    // wants a SINGLE result, not the whole matching list. Loose gap between
    // "one" and "product" so filler/profanity in between still matches.
    single_item_request: [
      /\bone\b[\w\s]{0,15}\bproducts?\b/i,
      /\bproducts?\b[\w\s]{0,15}\bone\b/i,
      /\bjust one\b/i,
      /\bonly one\b/i,
      /\bsingle (item|product)\b/i,
      /\bgive me one\b/i,
      /\bshow (me )?(just )?one\b/i,
      /\bat\s*least\s*one\b/i,
    ],
    item_price: [/\bprice\b/i, /\bcost\b/i, /\bhow much\b/i, /\bquote\b/i, /\bwholesale\b/i, /\b\d{1,7}\s*(pcs?|pieces?|units?|dozen|cartons?|boxes?|kg)\b/i],
    logistics_inquiry: [
      /\bhow (many days?|long|much time|soon)\b/i,
      /\bwhen (will|would|can|could)\b/i,
      /\b(delivery|shipping|sourcing|lead|transit)\s*(time|period|window|date|timeline|days?)\b/i,
      /\b(warehouse|lead time)\b/i,
      /\bdays?\b.*\b(source|deliver|ship|arrive|receive|get)\b/i,
      /\b(arrive|arrival|transit|get here)\b/i,
    ],
  },
  ar: {
    greeting_hello: [/^(مرحبا|مرحبتين|اهلا|أهلا|اهلين|أهلين|هلا|هالو|هلو|هاي|ألو|الو|حياك|حياكم|يا هلا|هلا والله|يا هلا والله|السلام عليكم|وعليكم السلام)/, /^(صباح الخير|مساء الخير|صباح النور|مساء النور)/],
    greeting_how_are_you: [/^(ايه اخبارك|عامل ايه|عامل اية|انت كويس|كيفك|شلونك|شلونكم|شخباركم|اخبارك|ازيك|إزيك|ايش اخبارك|كيف حالك)/],
    greeting_yasta: [/^(يسطا|يا اسطى|ياسطى|ي زميلي|يا زميلي|يصاحبي|يا صاحبي)/],
    thanks: [/(شكرا|شكراً|تسلم|يسلمو|ممنون|يعطيك العافية)/],
    guided_discovery: [/(مش عارف اختار|مش عارفة اختار|مش عارف ابدأ|مش عارف ابدا|منين ابدأ|منين ابدا|من وين ابدأ|معنديش خبرة|معنديش خبره|اول مرة اشتري|أول مرة اشتري|اختارلي|اختاري لي|رشحلي|رشح لي|وجهني|علمني اختار|ازاي اختار|إزاي اختار|كيف اختار|عايز حد يساعدني اختار|عاوز حد يساعدني اختار|محتار|محتارة|متلخبط|متلخبطة|تايه|تايهة|حاسس اني تايه|ساعدني الاقي|ساعدني ألاقي|ساعديني الاقي|عايز الاقي منتج|مش لاقي اللي يناسبني)/],
    help: [/(مساعدة|ساعدني|كيف يشتغل|كيف يعمل|ماذا يمكنك|بتعمل ايه|تساعدني)/],
    contact: [/(تواصل|اتصال|رقم|واتساب|هاتف|موبايل|ايميل|إيميل|تليفون|تلفون|كلمكم|اكلمكم)/],
    // Two ambiguity traps handled here:
    //  • "عمل" collides with "بتعمله"/"نعمل" (do you do…) -> dropped (مواعيد/ساعات
    //    العمل still match via مواعيد / the qualified ساعات below).
    //  • "ساعات"/"ساعة" ALSO means WATCHES (a product). Bare "ساعات" must NOT mean
    //    hours — only "ساعات العمل / الدوام / الفتح / عملكم" does. "عايزة ساعات"
    //    (I want watches) then flows to product search instead of hours.
    working_hours: [/(ساعات\s*(العمل|عمل|الدوام|عملكم|الفتح|التشغيل|الرسميه|الرسمية)|مواعيد|الدوام|شغالين|تفتح|تقفل|تفتحون|تغلقون|امتى|امتا|الساعة كام|الساعه كام)/],
    location: [/(العنوان|الموقع|وين|فين|أين|اتجاهات|خريطة|مكان|فروعكم|فرعكم)/],
    brand_info: [/(من انتم|مين انتم|نبذه عنكم|نبذة عنكم|من انتو|ماذا تقدمون|عن المتجر|عن المعرض|مين انت)/],
    catalog_general: [/(كتالوج|ايش عندكم|شو عندكم|عندكم ايه|عندك ايه|الكتالوج|وش عندكم)/],
    catalog_general_generic: [/(المنتجات|السوق|الماركت|المتجر)/],
    list_categories: [/(كل الاقسام|كل الأقسام|جميع الاقسام|جميع الأقسام|الاقسام الموجودة|الأقسام الموجودة|ايه الاقسام|إيه الأقسام|ايش الاقسام|شو الاقسام|عندكم اقسام ايه|عندكم أقسام ايه|الفئات المتاحة|كل الفئات|جميع الفئات|انواع المنتجات|أنواع المنتجات|التصنيفات)/],
    order_howto: [
      /كيف[؀-ۿ\s]{0,15}(اطلب|أطلب|الطلب|اعمل طلب|اعمل اوردر|اوردر)/,
      /ازاي[؀-ۿ\s]{0,15}(اطلب|أطلب|الطلب|اعمل اوردر|اعمل طلب)/,
      /طريقة الطلب/,
      /ابغى اطلب ازاي/,
      // Colloquial Egyptian: "اعملي بيه اوردر" / "اعمل اوردر" / "اعملي اوردر"
      /(اعملي?|عملي?)\s*(بيه|به|ليه|معه|منه|فيه|عليه|منك|دلوقتي|دلوقت)?\s*اوردر/,
      // "عايز اطلب" / "عايز اعمل اوردر" / "ابغى اطلب" etc.
      /(عايز|عاوز|عايزه|عاوزه|أريد|اريد|بدي|ابي|أبي|ابغى|أبغى|ودي|محتاج)\s*(اطلب|أطلب|اعمل اوردر|اعمل طلب|اشتري)/,
    ],
    ecommerce_search_hot: [/(الاكثر مبيعا|الأكثر مبيعا|ساخن|مشهور|مطلوب|اكتر مبيعا|البيست سيلر|الاكثر طلبا|الاكثر مبيعاً|الأكثر طلباً)/],
    ecommerce_category_info: [/(عن القسم|القسم|قسم|صنف|تصنيف|تفاصيل القسم)/],
    ecommerce_product_advantages: [/(مميزات|مزايا|فوائد|ليه اشتري|مواصفات)/],
    // Context follow-up in Arabic: "قلي تفاصيل اكتر عنه"، "اعرف اكتر"، "تفاصيل عنه".
    more_details: [/(تفاصيل اكتر|تفاصيل أكتر|تفاصيل اكثر|تفاصيل أكثر|اكتر عنه|أكتر عنه|اكثر عنه|اعرف اكتر|أعرف اكتر|معلومات اكتر|معلومات أكثر|قلي اكتر|قولي اكتر|قلي تفاصيل|قولي تفاصيل|تفاصيل عنه|تفاصيل عنها|زودني|فاصيل اكتر|ايه تفاصيله|ايه تفاصيلها|قلي عنه|قولي عنه|احكيلي عنه)/],
    ecommerce_check_availability: [/(متاح|متوفر|متوفره|متوفرة|موجود|موجوده|في المخزون)/],
    // Service-area question in Arabic: "شغالين في دول ايه؟"، "بتشتغلوا في اي
    // دوله؟"، "بتشحنوا لبرا؟"، "في اي بلد متواجدين؟". Requires a country/region
    // NOUN (دول/دوله/بلد/بلاد/الخليج) or a shipping-abroad verb so a plain
    // "شغالين النهاردة؟" (open today) still falls through to working_hours.
    service_area: [
      /(اي|أي|انهي|إنهي|إيه|ايه|مين|وش|شو|كام)\s*دول/,
      /دول\s*(اي|أي|ايه|إيه|انهي|إنهي|مين|كام)/,
      /(شغالين|شغال|بتشتغل|تشتغل|تشتغلون|بتشتغلوا|تشتغلوا|موجودين|متوفرين|متواجدين|بتبيعوا|تبيعون|بتوصلوا|توصلون|بتشحنوا|تشحنون|بتصدروا|تصدرون|بتوفروا|توفرون|تغطون|بتغطوا)\s*(في|ل|لـ|إلى|الى)?\s*(اي\s*)?(دول|دوله|دولة|بلد|بلاد|بلدان|الخليج|منطقه|منطقة|مناطق)/,
      /(تشحنوا|بتشحنوا|تشحنون|شحن|توصلوا|بتوصلوا|توصلون|توصيل|تصدير|بتصدروا)\s*(ل|لـ|إلى|الى)?\s*(اي|أي)?\s*(دول|دوله|دولة|بلد|بلاد|برا|بره|خارج|الخارج)/,
      /(دولكم|بلدكم|بلدانكم|الدول اللي|البلاد اللي|فروعكم في|متواجدين في|بتغطوا اي)/,
    ],
    // Presence/operation verb — combined with a recognized country name to catch
    // "انتم بتشتغله في المغرب؟" (specific country, no generic noun).
    service_area_verb: [/(شغالين|شغال|بتشتغل|تشتغل|تشتغلون|بتشتغلوا|تشتغلوا|تشتغله|بتشتغله|تعملون|بتعملوا|موجودين|متوفرين|متواجدين|بتبيعوا|تبيعون|بتوصلوا|توصلون|بتشحنوا|تشحنون|بتصدروا|تصدرون|عندكم|بتوفروا|توفرون|تغطون|بتغطوا)/],
    // "do you do dropshipping / wholesale / reselling?" — a business-model
    // question, NOT hours and NOT a product. "بتعمله دروبشبنج" used to hit hours.
    business_model: [/(دروب\s?شيبنج|دروب\s?شبنج|دروبشيب|دروبشبنج|دروب شيب|ريسيلر|اعاده بيع|إعادة بيع|بيع بالجمله|بيع بالجملة|بالجمله|بالجملة|جمله|جملة|وسيط|وكيل|توريد|بتوردوا|شراكه|شراكة|تسويق بالعموله|عموله|عمولة|افلييت|افليت)/],
    ecommerce_country_info: [/(سوق|اسواق|في بلد|في دوله|في دولة|السوق)/],
    ecommerce_country_products: [/(منتجات من|من بلد|من دولة|منتجات في|في السعودية|في مصر|في الإمارات|السعودية|مصر|الإمارات)/],
    single_item_request: [/(واحد بس|واحد فقط|منتج واحد|قطعة واحدة|عايز واحد|عاوز واحد|عايزة واحد|ولو واحد|على الاقل واحد|على الأقل واحد)/],
    // Adds "بكم" (variant of بكام) and a NUMBER+UNIT trigger: "بكم 100 حبة",
    // "سعر 50 قطعة". "حبة/قطعة/علبة/كرتونة/درزن/دستة/طن" are quantity units —
    // a quantity ask is inherently a price/quote question in a wholesale store.
    item_price: [/(سعر|اسعار|أسعار|بكام|بكم|بقديش|كم السعر|الثمن|حسابه|حسابها|كم حقها|حقها كم|عرض سعر|الجمله|الجملة|\d{1,7}\s*(حبة|حبه|قطعة|قطعه|قطع|علبة|علبه|كرتون|كرتونه|كرتونة|درزن|دستة|دسته|طن|كيلو))/],
    logistics_inquiry: [/(كم يوم|كم يومًا|كم يوماً|امتى|متى يوصل|كم مدة|وقت التوصيل|وقت الشحن|وقت التوريد|المخزن|المستودع|مدة التوريد|مدة الشحن|التسليم|فترة التوريد|هيوصل امتى|يوصل امتى|تاريخ التسليم)/],
  }
};

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function getDisplayTitle(item, lang) {
  return lang === 'ar' ? item.title_ar || item.title_en : item.title_en || item.title_ar;
}

function getDisplayCategory(item, lang) {
  return lang === 'ar' ? item.category_ar || item.category_en : item.category_en || item.category_ar;
}

function getDisplayCountry(item, lang) {
  const meta = item.metadata || {};
  return lang === 'ar' ? meta.country_ar || meta.country || meta.country_en : meta.country_en || meta.country || meta.country_ar;
}

function getDisplayDescription(item, lang) {
  return lang === 'ar' ? item.description_ar || item.description_en : item.description_en || item.description_ar;
}

// The distinct countries the catalog actually sources from, as display names in
// the active language. Drives the "which countries do you serve" answer.
function getServedCountries(items, lang) {
  const seen = new Set();
  const list = [];
  for (const item of items) {
    const display = getDisplayCountry(item, lang);
    if (!display) continue;
    const id = countryCanonicalId(getDisplayCountry(item, 'en') || display);
    if (seen.has(id)) continue;
    seen.add(id);
    list.push(display);
  }
  return list;
}

// Set of canonical ids the catalog serves, for a yes/no membership test against
// a specific country the customer named.
function getServedCountryIds(items) {
  const ids = new Set();
  for (const item of items) {
    const en = getDisplayCountry(item, 'en');
    if (en) ids.add(countryCanonicalId(en));
  }
  return ids;
}

function isSourcing(business) {
  return Number(business && business.sourcing_mode) === 1;
}

// Pulls a "<number> <unit>" quantity out of a message ("100 حبة", "50 pieces").
// حبة/حبه = unit/piece (colloquial "بكم 100 حبة" = price for 100 units). Returns
// { qty, unit } or null. Used so a price reply can acknowledge the exact
// quantity the customer already stated instead of asking for it again.
const QTY_UNIT_RE = /(\d{1,7})\s*(حبة|حبه|قطعة|قطعه|قطع|علبة|علبه|كرتون|كرتونه|كرتونة|درزن|دستة|دسته|طن|كيلو|pcs?|pieces?|units?|dozen|cartons?|boxes?|kg)/i;
function extractQuantity(text) {
  const match = String(text || '').match(QTY_UNIT_RE);
  if (!match) return null;
  const qty = Number(match[1]);
  return Number.isFinite(qty) && qty > 0 ? { qty, unit: match[2] } : null;
}

// Metadata keys that are internal plumbing imported from the source JSON, NOT
// customer-facing product specs. Never surface these as "features" or answer an
// inquiry about them (the source `id`/`slug` etc. leaked as "The id of X is 129"
// because the generic key match below was a loose substring test on a 2-char key).
const INTERNAL_META_KEYS = new Set([
  'id', 'slug', 'thumbnail', 'hot_selling', 'badge', 'availability', 'available',
  'country', 'country_en', 'country_ar',
]);

// Editable "Contact us" button target. Prefer the owner-set contact_link
// (whatsapp / mailto / any URL); else build a wa.me link from the phone; else a
// mailto from the email. Returns null when no contact channel is configured.
function getContactTarget(business) {
  const link = String(business.contact_link || '').trim();
  if (link) return link;
  const phone = String(business.phone || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (phone) return `https://wa.me/${phone}`;
  if (business.email) return `mailto:${business.email}`;
  return null;
}

function contactButton(business, locale) {
  const url = getContactTarget(business);
  if (!url) return null;
  return { label: locale === 'ar' ? 'تواصل معنا' : 'Contact us', url, target: '_blank' };
}

function marketplaceButton(business, locale) {
  if (!business.catalog_link) return null;
  return {
    label: locale === 'ar' ? 'تصفح السوق' : 'Open Marketplace',
    url: business.catalog_link,
    target: '_blank',
  };
}

// Sourcing brands keep prices private — any price question is answered with a
// quote invitation + Contact button instead of a number.
function sourcingPriceText(locale) {
  return locale === 'ar'
    ? 'يختلف سعر الجملة حسب الكمية المطلوبة. أرسل لنا الكمية التي تحتاجها وسنقدّم لك أفضل عرض سعر متاح.'
    : 'Wholesale pricing depends on the quantity you need. Send us the quantity you want and we’ll get you the best available quote.';
}

// Build a clean, compact feature block for a product, in the customer's language
// only (never both EN+AR). Returns an array of display lines:
//   "Advantages:" + one "• ..." bullet per comma-separated point (from details/
//   features), then "Product Code: ...", then any other custom spec keys with a
//   friendly label. Replaces the old raw "details_en: ..." dump.
function buildFeatureLines(item, locale) {
  const meta = item.metadata || {};
  const out = [];

  // 1) Advantages — from details_<lang>, falling back to features_<lang> array.
  let details = locale === 'ar' ? (meta.details_ar || meta.details_en) : (meta.details_en || meta.details_ar);
  if (!details) {
    const arr = locale === 'ar' ? (meta.features_ar || meta.features_en) : (meta.features_en || meta.features_ar);
    if (Array.isArray(arr) && arr.length) details = arr.join(', ');
  }
  if (details) {
    const cleaned = String(details).replace(/^\s*(key features|advantages|المميزات الأساسية|المميزات)\s*:?\s*/i, '').trim();
    const bullets = cleaned.split(/[,،]/).map((s) => s.trim()).filter(Boolean);
    if (bullets.length) {
      out.push(locale === 'ar' ? '**المميزات:**' : '**Advantages:**');
      bullets.forEach((b) => out.push(`• ${b}`));
    }
  }

  // 2) Product code (SKU) — friendly label, one line.
  if (meta.code) out.push((locale === 'ar' ? '**كود المنتج:** ' : '**Product Code:** ') + meta.code);

  // 3) Any remaining custom string specs (color, material, ...) — current
  //    language only, friendly label, skipping internal/already-handled keys.
  const handled = new Set(['details_en', 'details_ar', 'details', 'features_en', 'features_ar', 'features', 'code']);
  for (const [k, v] of Object.entries(meta)) {
    const kl = k.toLowerCase();
    if (INTERNAL_META_KEYS.has(kl) || handled.has(kl)) continue;
    if ((kl.endsWith('_ar') && locale !== 'ar') || (kl.endsWith('_en') && locale === 'ar')) continue;
    if (typeof v === 'string' && v.trim()) {
      const canon = kl.replace(/_(en|ar)$/, '');
      const label = (FEATURE_LABELS[locale] || {})[canon] || (canon.charAt(0).toUpperCase() + canon.slice(1));
      out.push(`**${label}:** ${v.trim()}`);
    }
  }

  return out;
}

// Detect a marketing-badge filter ("what's new", "limited products", "trending").
function detectBadge(text) {
  const normalized = String(text || '').toLowerCase();
  for (const [canonical, synonyms] of Object.entries(BADGE_SYNONYMS)) {
    const hit = synonyms.some((syn) => {
      const s = syn.toLowerCase();
      // Latin synonyms match on word boundaries — "wholesale" must NOT hit
      // "sale". Arabic has no \b semantics, so keep substring matching there.
      if (/^[a-z\s]+$/.test(s)) {
        return new RegExp(`\\b${s.replace(/\s+/g, '\\s+')}\\b`).test(normalized);
      }
      return normalized.includes(s);
    });
    if (hit) return canonical;
  }
  return null;
}

function itemBadge(item) {
  const meta = item.metadata || {};
  return String(meta.badge || '').toLowerCase();
}

function isHotSelling(item) {
  const meta = item.metadata || {};
  return String(meta.hot_selling) === 'true' || meta.hot_selling === true;
}

function resolveMetadataValue(meta, canonicalKey, lang) {
  if (meta[canonicalKey] !== undefined) return meta[canonicalKey];
  const keyEn = `${canonicalKey}_en`;
  const keyAr = `${canonicalKey}_ar`;
  if (lang === 'ar') {
    if (meta[keyAr] !== undefined) return meta[keyAr];
    if (meta[keyEn] !== undefined) return meta[keyEn];
  } else {
    if (meta[keyEn] !== undefined) return meta[keyEn];
    if (meta[keyAr] !== undefined) return meta[keyAr];
  }
  return null;
}

function detectFeatureInquiry(text, lang, item) {
  if (!item || !item.metadata) return null;
  const normalizedText = text.toLowerCase();

  let meta = item.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }

  for (const [canonicalKey, synonyms] of Object.entries(FEATURE_SYNONYMS)) {
    for (const syn of synonyms) {
      if (normalizedText.includes(syn.toLowerCase())) {
        const val = resolveMetadataValue(meta, canonicalKey, lang);
        if (val) {
          return {
            intent: 'ecommerce_inquire_feature',
            item,
            featureKey: canonicalKey,
            featureLabel: canonicalKey,
            featureValue: val,
          };
        }
      }
    }
  }

  for (const [key, value] of Object.entries(meta)) {
    const k = key.toLowerCase();
    // Skip internal keys (id/slug/...) and short keys, and require a WHOLE-WORD
    // match — not a substring — so "id" never fires inside "provide"/"consider".
    if (INTERNAL_META_KEYS.has(k) || k.length < 4) continue;
    const re = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (re.test(normalizedText)) {
      return {
        intent: 'ecommerce_inquire_feature',
        item,
        featureKey: key,
        featureLabel: key,
        featureValue: resolveMetadataValue(meta, key, lang),
      };
    }
  }

  return null;
}

// Find a strong title match among OUT-OF-STOCK rows (which getBusinessItems hides)
// so "do you have X?" for an existing-but-unavailable product can answer "we'll
// source it" instead of a flat not-found. Requires a real overlap (a full-phrase
// hit, or 2+ shared tokens) so random text never triggers a false sourcing offer.
function findUnavailableMatch(text, lang, businessId) {
  const out = getAllBusinessItems(businessId).filter((i) => !i.in_stock);
  if (!out.length) return null;
  const needle = normalize(text, lang);
  const tokens = tokenize(needle).filter((t) => t.length > 2);
  if (!tokens.length) return null;

  let best = null;
  let bestScore = 0;
  let bestFull = false;
  let bestHits = 0;
  for (const item of out) {
    const title = normalize(`${item.title_en || ''} ${item.title_ar || ''}`, lang);
    if (!title) continue;
    const full = needle.length > 2 && title.includes(needle);
    const hits = tokens.filter((t) => title.includes(t)).length;
    const score = (full ? 100 : 0) + hits * 5 + (hits / tokens.length) * 10;
    if (score > bestScore) {
      bestScore = score;
      best = item;
      bestFull = full;
      bestHits = hits;
    }
  }
  return (bestFull || bestHits >= 2) ? best : null;
}

function findEcommerceItems(text, lang, businessId, context = {}) {
  const items = getBusinessItems(businessId);
  const scoredMatchesAll = findScoredItems({
    text,
    lang,
    items,
    context,
    getItemVariants: (item) => [item.title_en, item.title_ar],
    getCategoryVariants: (item) => [item.category_en, item.category_ar],
    getExtraVariants: (item) => {
      let meta = item.metadata || {};
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      const extras = [
        item.description_en,
        item.description_ar,
        meta.country,
        meta.country_ar,
        meta.country_en
      ];
      for (const [k, v] of Object.entries(meta)) {
        if (typeof v === 'string') extras.push(v);
      }
      return extras.filter(Boolean);
    },
  });

  const scoredMatches = uniqueScoredByTitle(scoredMatchesAll, lang);

  return {
    items,
    scoredMatches,
    matchedItems: scoredMatches.map((entry) => entry.item),
    categoryMatches: findMatchingCategories({
      text,
      lang,
      items,
      getCategoryVariants: (item) => [item.category_en, item.category_ar],
      getCategoryDisplay: getDisplayCategory,
    }),
  };
}

function detectIntent({ text, lang, business, context = {} }) {
  const result = runDetectIntent({ text, lang, business, context });
  if (result) {
    result.queryText = text;
  }
  return result;
}

function runDetectIntent({ text, lang, business, context = {} }) {
  const patterns = PATTERNS[lang] || PATTERNS.en;
  const normalizedText = normalize(text, lang);
  const { items, scoredMatches, matchedItems, categoryMatches } = findEcommerceItems(text, lang, business.id, context);
  const foundItem = matchedItems[0] || null;
  const topScore = scoredMatches[0]?.score || 0;
  const secondScore = scoredMatches[1]?.score || 0;

  if (matchesAny(normalizedText, patterns.greeting_hello)) return { intent: 'greeting_hello' };
  if (matchesAny(normalizedText, patterns.greeting_how_are_you)) return { intent: 'greeting_how_are_you' };
  if (matchesAny(normalizedText, patterns.greeting_yasta)) return { intent: 'greeting_yasta' };
  if (matchesAny(normalizedText, patterns.thanks)) return { intent: 'thanks' };

  // Kick-off continuation. After we invited the customer to explore (help /
  // browse / discovery reply sets awaiting_discovery), a bare "so lets start" /
  // "ok go ahead" / "يلا" means "walk me through it" — start guided discovery
  // instead of falling to unknown (or, worse, a random FAQ). Strictly gated on
  // the flag AND an affirmative-only message so nothing else is hijacked.
  const KICKOFF_RE = /^(so |ok |okay |yes |yeah |well )*(let'?s? |lets )?(start|begin|go|go ahead|do it|do this|discover|explore)( together| now| then)?\s*[!.?]*$/i;
  const KICKOFF_AR_RE = /^(يلا|يالله|يلا بينا|ابدأ|ابدا|نبدأ|نبدا|خلينا نبدأ|خلينا نبدا|تمام يلا|ماشي يلا|جاهز|جاهزة)\s*[!.؟]*$/;
  if (context.awaiting_discovery
    && (KICKOFF_RE.test(String(text || '').trim()) || KICKOFF_AR_RE.test(String(text || '').trim()))) {
    const categories = [...new Set(items.map((item) => getDisplayCategory(item, lang)).filter(Boolean))];
    return { intent: 'guided_discovery', categories };
  }

  // Checked before the generic `help` intent (phrases like "help me choose"
  // contain "help" too) so a customer with no idea what to buy gets walked
  // through a real choice instead of a capabilities blurb or an AI freeform
  // reply that just asks them to restate what they already said they don't know.
  if (matchesAny(normalizedText, patterns.guided_discovery)) {
    const categories = [...new Set(items.map((item) => getDisplayCategory(item, lang)).filter(Boolean))];
    return { intent: 'guided_discovery', categories };
  }

  if (matchesAny(normalizedText, patterns.help)) return { intent: 'help' };

  // "How do I order?" with NO specific product named -> ask which products
  // instead of opening an empty cart. When a product IS named the order flow
  // takes over and opens a seeded order, so gate this on !foundItem.
  if (!foundItem && matchesAny(normalizedText, patterns.order_howto)) {
    return { intent: 'order_howto' };
  }

  // "Do you do dropshipping / wholesale / reselling?" — a business-model
  // question. Checked before working_hours (its "بتعمله" used to hit hours) and
  // before service_area so a dropshipping ask isn't answered as a country query.
  if (matchesAny(normalizedText, patterns.business_model)) {
    return { intent: 'business_model' };
  }

  // Service-area / "which countries do you serve" — MUST be checked before
  // working_hours, because "شغالين"/"work" appear in both and the hours pattern
  // would otherwise hijack "انتم شغالين في دول ايه؟". Answered from the catalog's
  // real country data so the customer gets a concrete yes/no + the served list.
  const namedCountry = detectAnyKnownCountry(normalizedText, lang);
  const servedIds = getServedCountryIds(items);
  const namedServed = namedCountry ? servedIds.has(namedCountry.id) : false;
  // A recognized country we DON'T stock, mentioned in ANY way — a bare follow-up
  // ("طب والمغرب؟"), a "do you serve X", or a "products from X" — must be answered
  // honestly ("we don't cover X"). Otherwise the AI hallucinated a "yes", and the
  // product path showed a wrong-country item as if it were from there.
  const namedUnservedCountry = Boolean(namedCountry) && !namedServed;
  const serviceAreaAsked = matchesAny(normalizedText, patterns.service_area)
    || (namedCountry && matchesAny(normalizedText, patterns.service_area_verb));
  if (serviceAreaAsked || namedUnservedCountry) {
    const servedList = getServedCountries(items, lang);
    return {
      intent: 'service_area',
      named: namedCountry,
      isServed: namedServed,
      servedList,
      hasCountryData: servedList.length > 0,
    };
  }

  if (matchesAny(normalizedText, patterns.contact)) return { intent: 'contact' };
  // The hours pattern now only matches UNAMBIGUOUS forms (مواعيد / امتى / "ساعات
  // العمل"...), never bare "ساعات" (=watches) — so no foundItem gate is needed:
  // "ساعات العمل ايه" is hours even when the catalog sells watches. The one guard
  // left is explicit negation ("منتج مش ساعات العمل" = a product, NOT hours).
  const negatesHours = /(مش|مو|ليس|مهو|مب|لا)\s*(ال)?ساعات/.test(normalizedText);
  if (!negatesHours && matchesAny(normalizedText, patterns.working_hours)) return { intent: 'working_hours' };
  if (matchesAny(normalizedText, patterns.location)) return { intent: 'location' };
  if (matchesAny(normalizedText, patterns.brand_info)) return { intent: 'brand_info' };

  // "What categories do you have?" — answered straight from the catalog
  // already loaded above, no AI classification needed for static metadata.
  if (matchesAny(normalizedText, patterns.list_categories)) {
    const categories = [...new Set(items.map((item) => getDisplayCategory(item, lang)).filter(Boolean))];
    return { intent: 'list_categories', categories };
  }

  // Contextual or explicit dynamic feature inquiry check. Resolve the item we're
  // discussing from last_item; if that wasn't set (e.g. an AI recommendation that
  // named several items), fall back to the most recently tracked item so a "عنه"
  // / "it" follow-up still has a subject.
  const contextItemId = Number.isFinite(context.last_item)
    ? context.last_item
    : (Array.isArray(context.recent_item_ids) && context.recent_item_ids.length
      ? context.recent_item_ids[context.recent_item_ids.length - 1]
      : null);
  const itemInContext = foundItem || (contextItemId ? items.find(i => i.id === contextItemId) : null);
  if (itemInContext) {
    const featureInquiry = detectFeatureInquiry(normalizedText, lang, itemInContext);
    if (featureInquiry) return featureInquiry;
    // Context-dependent chips like the "Advantages" suggestion send only the word
    // with NO product named. Resolve them against the last item shown instead of
    // dead-ending on not-found.
    if (matchesAny(normalizedText, patterns.ecommerce_product_advantages)) {
      return { intent: 'ecommerce_product_advantages', item: itemInContext };
    }
    // "tell me more about it" / "قلي تفاصيل اكتر عنه" -> show the full product
    // card for the item we're already discussing (resolved locally, in-language).
    if (matchesAny(normalizedText, patterns.more_details)) {
      return { intent: 'item_found', item: itemInContext, fromContext: true };
    }
  }

  const asksPriceBase = matchesAny(normalizedText, patterns.item_price);
  // Quantity the customer stated ("بكم 100 حبة") — echoed back in price replies.
  const askedQuantity = extractQuantity(text);
  // "send me one product", "one fuckin product" — a hard cap to a SINGLE
  // result. Checked everywhere a list would otherwise be returned so a
  // quantity-limited ask never gets dumped the full matching set.
  const wantsOne = matchesAny(normalizedText, patterns.single_item_request);

  // Country checking. A category named in the SAME message ("electronics in
  // saudi arabia") narrows the pool before the country filter runs, so the
  // two constraints combine instead of the category being silently dropped.
  // Detection can resolve to SEVERAL countries when a region is named ("دول
  // الخليج" -> every Gulf country stocked). Filtering matches ANY of them.
  const detectedCountries = detectCountries(normalizedText, lang, items);
  // last_country may be stored as a single string (older turns) or an array
  // (a region) — normalize either into a list for the carry-over case.
  const priorCountries = Array.isArray(context.last_country)
    ? context.last_country
    : (context.last_country ? [context.last_country] : []);
  // No country in THIS message, but a category was just asked about right
  // after we filtered by country ("but it should be electronics") -> keep
  // narrowing the same country/countries instead of reverting to all.
  const carriedCountries = !detectedCountries.length && categoryMatches.length === 1 && priorCountries.length
    ? priorCountries
    : [];
  const activeCountries = detectedCountries.length ? detectedCountries : carriedCountries;
  // A served country named RIGHT HERE ("منتج من الامارات") is an explicit request
  // to see that country's products — show them, don't gate on the brittle
  // hardcoded phrase list (which misses "منتج من" and any non-Saudi/Egypt/UAE
  // country). The gating below only still matters for a CARRIED country.
  const countryNamedThisTurn = detectedCountries.length > 0;
  // Display label for headlines ("available in الإمارات، السعودية"); the array
  // drives filtering + context so carry-over still does exact per-country matches.
  const activeCountry = activeCountries.join(lang === 'ar' ? '، ' : ', ');

  if (activeCountries.length) {
    const filterCountry = (i) => activeCountries.some((c) => countryMatchesItem(i, c));
    const categoryMatch = categoryMatches.length === 1 ? categoryMatches[0] : null;
    const basePool = categoryMatch ? categoryMatch.items : items;

    if (matchesAny(normalizedText, patterns.ecommerce_search_hot)) {
      const filtered = basePool.filter(isHotSelling).filter(filterCountry);
      if (wantsOne && filtered.length) {
        return { intent: 'item_found', item: filtered[0], country: activeCountry, countries: activeCountries };
      }
      return { intent: 'ecommerce_search_hot', items: filtered, country: activeCountry, countries: activeCountries, category: categoryMatch?.display };
    }

    if (countryNamedThisTurn
      || matchesAny(normalizedText, patterns.ecommerce_country_products)
      || tokensCount(normalizedText) <= 3
      || categoryMatch
      || wantsOne) {
      const filtered = basePool.filter(filterCountry);
      if (wantsOne && filtered.length) {
        return { intent: 'item_found', item: filtered[0], country: activeCountry, countries: activeCountries };
      }
      return { intent: 'ecommerce_country_products', items: filtered, country: activeCountry, countries: activeCountries, category: categoryMatch?.display };
    }
  }

  // "just give me one" with no country/category named THIS turn -> resolve
  // against whatever we already showed instead of bouncing to a content-free
  // AI filler reply (that reply doesn't know "one" refers to the prior list).
  if (wantsOne && !foundItem) {
    const recentIds = Array.isArray(context.recent_item_ids) ? context.recent_item_ids : [];
    if (recentIds.length) {
      const pick = items.find((i) => i.id === recentIds[recentIds.length - 1]);
      if (pick) return { intent: 'item_found', item: pick, fromContext: true };
    }
  }

  // Hot / best selling (hot_selling boolean), optionally inside one category.
  if (matchesAny(normalizedText, patterns.ecommerce_search_hot)) {
    const hotItems = items.filter(isHotSelling);
    if (categoryMatches.length === 1) {
      return { intent: 'ecommerce_search_hot', items: hotItems.filter(i => getDisplayCategory(i, lang) === categoryMatches[0].display) };
    }
    return { intent: 'ecommerce_search_hot', items: hotItems };
  }

  // Marketing badge filter ("what's new", "trending", "limited"). Only when no
  // single product is the clear subject (a named product wins below).
  if (!foundItem) {
    const badge = detectBadge(normalizedText);
    if (badge) {
      // An owner-authored FAQ that strongly matches the message ("do you
      // offer samples", "discounts for bulk quantities") outranks a badge
      // listing — "offer"/"discount" appear in both, but the FAQ is the
      // actual answer. Falling through ends in `unknown`, where the FAQ
      // fallback in message.js serves that exact answer.
      const faqHit = matchFaq({ text, lang, business });
      if (!(faqHit && faqHit.overlap >= 2)) {
        const badgeItems = items.filter((i) => itemBadge(i).includes(badge));
        return { intent: 'ecommerce_badge', items: badgeItems, badge };
      }
    }
  }

  // Logistics / timeline questions: "how many days to source", "delivery time",
  // "when will it arrive". These contain words like "source", "product",
  // "warehouse" that accidentally score weakly against item descriptions.
  // Catch them before the item-found block so no random product card shows.
  // A general "on average / roughly" question with no specific product named
  // gets a REAL ballpark answer here — "contact us" doesn't actually answer
  // "how many days on average", it dodges it, and the AI classifier has shown
  // it bails on this exact shape of question rather than reasoning about it.
  const asksGeneralAverage = /\b(avg|average|on average|roughly|approx(imately)?|generally|typically|usually|ballpark|rough(ly)? estimate)\b/i.test(normalizedText)
    || /(متوسط|بالمتوسط|تقريبا|تقريباً|عادة|غالبا|غالباً)/.test(normalizedText);
  if (matchesAny(normalizedText, patterns.logistics_inquiry)) {
    // A follow-up refining the SAME ballpark conversation ("what if the
    // distance is only 1-3km") doesn't repeat "average" wording, but it's
    // still the same open-ended estimate question, not a specific-order
    // lookup — keep answering it, don't drop back to a flat "contact us".
    const isFollowup = Boolean(context.last_logistics_topic) && !foundItem;
    if ((asksGeneralAverage || isFollowup) && !foundItem) {
      const mentionsShortDistance = /\b\d+\s*-?\s*\d*\s*(km|kilo(metre|meter)?s?|miles?)\b/i.test(normalizedText)
        || /\b(nearby|close by|same city|next door|walking distance)\b/i.test(normalizedText)
        || /(قريب|جنب|نفس المدينة|كيلو)/.test(normalizedText);
      return { intent: 'logistics_average', mentionsShortDistance };
    }
    return { intent: 'logistics_inquiry' };
  }

  if (foundItem && topScore >= 10) {
    // (Advantages is handled above via itemInContext, which already covers foundItem.)
    if (matchedItems.length === 1 || (matchedItems.length > 1 && topScore >= secondScore + 3)) {
      if (asksPriceBase) return { intent: 'item_price', item: foundItem, quantity: askedQuantity };
      return { intent: 'item_found', item: foundItem };
    }
  }

  // Price question with no resolvable product -> quote invitation (sourcing) or
  // a "tell me which product" nudge (normal store).
  if (asksPriceBase && !foundItem && categoryMatches.length !== 1) {
    return { intent: 'ecommerce_price_quote', quantity: askedQuantity };
  }

  if (matchesAny(normalizedText, patterns.catalog_general)
    || (matchesAny(normalizedText, patterns.catalog_general_generic) && tokensCount(normalizedText) <= 6)) {
    return { intent: 'catalog_general' };
  }

  if (categoryMatches.length === 1) {
    const categoryMatch = categoryMatches[0];
    if (matchesAny(normalizedText, patterns.ecommerce_category_info)) {
      return { intent: 'ecommerce_category_info', category: categoryMatch.display, items: categoryMatch.items };
    }
    if (categoryMatch.items.length === 1 || wantsOne) {
      if (asksPriceBase) return { intent: 'item_price', item: categoryMatch.items[0], quantity: askedQuantity };
      return { intent: 'item_found', item: categoryMatch.items[0] };
    }
    return {
      intent: 'category_items',
      category: categoryMatch.display,
      items: categoryMatch.items,
    };
  }

  // Only ask "which one did you mean?" when the matches are STRONG (a real
  // name-level hit, same bar as item_found). A query like "عطر البراطور" matches
  // every perfume on the generic word "عطر" while the distinguishing word
  // "البراطور" matches nothing — those weak category-word matches must NOT be
  // offered as a disambiguation; they fall through to unavailable/not-found so
  // the customer gets a proper "we can source it" answer instead.
  if (matchedItems.length > 1 && topScore >= 10) {
    return { intent: 'item_disambiguation', items: matchedItems };
  }

  // Nothing matched an in-stock product. Before giving up, check whether the
  // customer named a product that EXISTS but is out of stock -> "we'll source it".
  const unavailable = findUnavailableMatch(text, lang, business.id);
  if (unavailable) {
    return { intent: 'ecommerce_unavailable', item: unavailable };
  }

  const tokens = tokenize(normalizedText);
  if (tokens.length && tokens.length <= 3) {
    return { intent: 'item_not_found' };
  }

  return { intent: 'unknown' };
}

function tokensCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function buildResponse(intentResult, lang, business) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const sourcing = isSourcing(business);
  const parseSuggestions = () => {
    try {
      const parsed = JSON.parse(business[`suggestions_${locale}`] || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const suggestions = parseSuggestions();
  const payload = {
    text: '',
    type: 'text',
    buttons: [],
    suggestions: [],
    context_update: {},
  };

  const addContactButton = () => {
    const btn = contactButton(business, locale);
    if (btn) payload.buttons.push(btn);
  };
  const addMarketplaceButton = () => {
    const btn = marketplaceButton(business, locale);
    if (btn) payload.buttons.push(btn);
  };

  // Shared builder for the multi-item cases below. Collapses to a single image
  // bubble when every item shares one thumbnail, splits to one bubble per item
  // when the URLs differ, and returns null (plain text) when none have one.
  const applyItemList = (items, heading) => {
    const itemLine = (item) => {
      const title = getDisplayTitle(item, locale);
      const desc = getDisplayDescription(item, locale);
      const priceText = !sourcing && item.price !== null && item.price !== undefined
        ? `\n${locale === 'ar' ? 'السعر' : 'Price'}: ${item.price} ${item.currency}`
        : '';
      return `**${title}**\n${desc}${priceText}`;
    };
    const thumbMsgs = buildThumbnailMessages(items, heading, itemLine);
    if (thumbMsgs) {
      payload.messages = thumbMsgs;
      payload.text = thumbMsgs.map((m) => m.text).filter(Boolean).join('\n\n');
    } else {
      payload.text = [heading, ...items.map(itemLine)].join('\n\n');
    }
  };

  switch (intentResult.intent) {
    case 'greeting_hello':
      payload.text = locale === 'ar'
        ? `أهلاً بك في ${business.name_ar || business.name}. كيف أساعدك اليوم؟`
        : `Hello from ${business.name}. How can I help you today?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'greeting_how_are_you':
      payload.text = locale === 'ar'
        ? `أنا بخير، شكراً لسؤالك! أهلاً بك في ${business.name_ar || business.name}. كيف أساعدك اليوم؟`
        : `I'm doing great, thanks for asking! Welcome to ${business.name}. How can I help you today?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'greeting_yasta':
      payload.text = locale === 'ar'
        ? `حبيبي يسطا! منور ${business.name_ar || business.name}. أقدر أساعدك إزاي؟`
        : `Hey there! Welcome to ${business.name}. How can I help you?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'thanks':
      payload.text = locale === 'ar'
        ? 'على الرحب والسعة. إذا احتجت أي شيء آخر فقط اسأل.'
        : 'You are welcome. If you need anything else, just ask.';
      payload.suggestions = suggestions.slice(0, 3);
      break;
    case 'help':
      payload.text = locale === 'ar'
        ? 'أقدر أساعدك في تصفّح السوق، المنتجات الأكثر مبيعاً، تفاصيل المنتجات ومزاياها، وإتمام الطلب. نبدأ؟'
        : 'I can help you browse the Marketplace, find best-selling products, check product details, and place an order. Shall we start?';
      payload.suggestions = suggestions.slice(0, 4);
      // A follow-up "yes / lets start" walks them into guided discovery.
      payload.context_update.awaiting_discovery = true;
      break;

    // "How do I order?" -> ask which products; the awaiting flag (set here and in
    // message.js) makes the NEXT product-naming message open a seeded order.
    case 'order_howto':
      payload.text = locale === 'ar'
        ? 'بكل سهولة! أرسل لي اسم المنتج أو المنتجات التي تريد طلبها وسأبدأ معك الطلب وأكمل العملية كاملة هنا في المحادثة.'
        : 'Easy! Just send me the product (or products) you’d like to order and I’ll start the order and complete the whole process right here in chat.';
      payload.suggestions = suggestions.slice(0, 4);
      payload.context_update.awaiting_order_products = true;
      break;

    case 'catalog_general':
      payload.text = locale === 'ar'
        ? 'تفضّل، يمكنك تصفّح السوق كاملاً من الزر بالأسفل — أو قولي بتدور على إيه وأنا أساعدك تلاقيه.'
        : "Sure — you can browse our full Marketplace from the button below, or tell me what you're looking for and I'll help you find it.";
      addMarketplaceButton();
      // "lets discover the marketplace together" ... "so lets start" -> walk
      // them into guided discovery instead of dead-ending.
      payload.context_update.awaiting_discovery = true;
      break;

    case 'logistics_inquiry':
      payload.text = locale === 'ar'
        ? 'للاستفسار عن مدة التوريد والشحن، تواصل معنا مباشرة — نقدر نعطيك توقيت دقيق حسب المنتج والكمية.'
        : 'For sourcing timelines and delivery questions, please contact us directly — we can give you accurate timing based on the specific product and quantity.';
      addContactButton();
      break;

    case 'logistics_average':
      if (intentResult.mentionsShortDistance) {
        payload.text = locale === 'ar'
          ? 'لو المسافة بين المخزنين كام كيلو بس، وقت الشحن نفسه هيبقى يوم أو اتنين — أغلب الوقت بيروح في تجهيز الطلب عند المورد مش في المسافة. يعني هيبقى حوالي 7-14 يوم بدل الـ10-20. لو عايز رقم دقيق، ابعتلنا اسم المنتج والكمية.'
          : "If the two warehouses are only a few km apart, the shipping leg itself is basically same-day or next-day — most of the timeline is the supplier's prep/production time, not distance. So with that short a distance you're looking at roughly 7-14 days total instead of the full 10-20. For an exact number, send us the product name and quantity.";
      } else {
        payload.text = locale === 'ar'
          ? 'كتقدير عام: تجهيز وشحن كمية زي 100 قطعة من منتج خفيف الوزن بياخد غالباً حوالي 10-20 يوم (تجهيز عند المورد + شحن)، والرقم ده بيختلف حسب المنتج والمورد والوجهة. لو عايز رقم دقيق لطلبك، ابعتلنا اسم المنتج والكمية ونأكدلك التوقيت الفعلي.'
          : "As a general ballpark: sourcing and shipping a quantity like 100 units of a lightweight item typically runs about 10-20 days total (supplier prep + transit), though it varies by product, supplier, and destination. For an exact timeline on your order, send us the product name and quantity and we'll confirm the real number.";
      }
      payload.context_update.last_logistics_topic = true;
      addContactButton();
      break;

    case 'ecommerce_price_quote': {
      const q = intentResult.quantity;
      const qtyLine = q
        ? (locale === 'ar'
          ? `تمام، لكمية ${q.qty} ${q.unit}: `
          : `Got it — for a quantity of ${q.qty} ${q.unit}: `)
        : '';
      payload.text = qtyLine + (sourcing
        ? sourcingPriceText(locale)
        : (locale === 'ar'
          ? 'أخبرني باسم المنتج الذي تريد معرفة سعره وسأساعدك.'
          : 'Tell me which product you’d like a price for and I’ll help.'));
      if (sourcing) addContactButton();
      payload.suggestions = suggestions.slice(0, 3);
      break;
    }

    case 'ecommerce_unavailable': {
      const item = intentResult.item;
      const title = getDisplayTitle(item, locale);
      payload.text = locale === 'ar'
        ? `**${title}** غير متوفر في المخزون حالياً، لكن لا تقلق — يمكننا توفيره لك من خلال شبكة الموردين لدينا. تواصل معنا وسنعمل على تأمينه في أقرب وقت.`
        : `**${title}** isn’t in stock right now — but no worries, we can source it for you through our supplier network. Contact us and we’ll work on getting it as soon as possible.`;
      const thumb = getItemThumbnail(item);
      if (thumb) payload.thumbnail = thumb;
      addContactButton();
      payload.suggestions = suggestions.slice(0, 3);
      payload.context_update.last_item = item.id;
      break;
    }

    case 'ecommerce_inquire_feature': {
      const item = intentResult.item;
      const title = getDisplayTitle(item, locale);
      const label = FEATURE_LABELS[locale][intentResult.featureKey] || intentResult.featureLabel;
      payload.text = locale === 'ar'
        ? `${label} لـ **${title}** هو: ${intentResult.featureValue}`
        : `The ${label} of **${title}** is: ${intentResult.featureValue}`;
      const thumb = getItemThumbnail(item);
      if (thumb) payload.thumbnail = thumb;
      payload.suggestions = locale === 'ar' ? [`اطلب ${title}`, 'المميزات'] : [`Order ${title}`, 'Advantages'];
      payload.context_update.last_item = item.id;
      break;
    }

    case 'ecommerce_country_products':
      if (intentResult.items && intentResult.items.length > 0) {
        const heading = intentResult.category
          ? (locale === 'ar'
            ? `إليك منتجات ${intentResult.category} المتوفرة في ${intentResult.country}:`
            : `Here are the ${intentResult.category} products available in ${intentResult.country}:`)
          : (locale === 'ar'
            ? `إليك المنتجات المتوفرة في ${intentResult.country}:`
            : `Here are the products available in ${intentResult.country}:`);
        applyItemList(intentResult.items.slice(0, 6), heading);
        payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      } else {
        payload.text = intentResult.category
          ? (locale === 'ar'
            ? `لم نجد منتجات ${intentResult.category} متوفرة في ${intentResult.country} حالياً، لكن يمكننا توفير ما تحتاجه من شبكتنا — تواصل معنا.`
            : `We couldn't find ${intentResult.category} products in ${intentResult.country} right now, but we can source what you need from our network — contact us.`)
          : (locale === 'ar'
            ? `لم نجد منتجات متوفرة في ${intentResult.country} حالياً، لكن يمكننا توفير ما تحتاجه من شبكتنا — تواصل معنا.`
            : `We couldn't find products in ${intentResult.country} right now, but we can source what you need from our network — contact us.`);
        addContactButton();
      }
      payload.context_update.last_country = intentResult.countries || intentResult.country;
      if (intentResult.category) payload.context_update.last_category = intentResult.category;
      break;

    case 'ecommerce_search_hot':
      if (intentResult.items && intentResult.items.length > 0) {
        const headline = intentResult.country
          ? (locale === 'ar' ? `إليك المنتجات الأكثر طلباً في ${intentResult.country}:` : `Here are the hot selling products in ${intentResult.country}:`)
          : (locale === 'ar' ? 'إليك المنتجات الأكثر طلباً ومبيعاً لدينا:' : 'Here are our hot selling products:');
        applyItemList(intentResult.items.slice(0, 6), headline);
        payload.suggestions = intentResult.items.slice(0, 3).map(item => getDisplayTitle(item, locale));
      } else {
        payload.text = locale === 'ar' ? 'لم نحدد منتجات كأكثر مبيعاً حالياً، لكن يمكنك تصفّح السوق لأحدث ما لدينا.' : 'No best-sellers are flagged right now, but you can browse the Marketplace for our latest products.';
        addMarketplaceButton();
      }
      if (intentResult.country) payload.context_update.last_country = intentResult.countries || intentResult.country;
      if (intentResult.category) payload.context_update.last_category = intentResult.category;
      break;

    case 'ecommerce_badge': {
      const labelMap = {
        en: { trending: 'trending', new: 'new', limited: 'limited', offer: 'special offer' },
        ar: { trending: 'الرائجة', new: 'الجديدة', limited: 'المحدودة', offer: 'العروض' },
      };
      const badgeLabel = (labelMap[locale] || labelMap.en)[intentResult.badge] || intentResult.badge;
      if (intentResult.items && intentResult.items.length > 0) {
        const heading = locale === 'ar'
          ? `إليك المنتجات ${badgeLabel} لدينا:`
          : `Here are our ${badgeLabel} products:`;
        applyItemList(intentResult.items.slice(0, 6), heading);
        payload.suggestions = intentResult.items.slice(0, 3).map(item => getDisplayTitle(item, locale));
      } else {
        // Nothing carries that badge — don't dead-end; suggest hot items instead
        // and make clear it's a suggestion, not a direct match (per the brief).
        const fallback = getBusinessItems(business.id).filter(isHotSelling).slice(0, 4);
        if (fallback.length) {
          const heading = locale === 'ar'
            ? `لا يوجد لدينا منتجات ${badgeLabel} حالياً، لكن إليك بعض المنتجات الأكثر طلباً التي قد تهمّك:`
            : `We don't have ${badgeLabel} products right now, but here are some best-sellers you might like instead:`;
          applyItemList(fallback, heading);
          payload.suggestions = fallback.slice(0, 3).map(item => getDisplayTitle(item, locale));
        } else {
          payload.text = locale === 'ar'
            ? `لا يوجد لدينا منتجات ${badgeLabel} حالياً. يمكنك تصفّح السوق كاملاً.`
            : `We don't have ${badgeLabel} products right now. You can browse the full Marketplace.`;
          addMarketplaceButton();
        }
      }
      break;
    }

    case 'ecommerce_category_info':
      payload.text = locale === 'ar'
        ? `قسم ${intentResult.category} يحتوي على العديد من المنتجات الرائعة. هل تبحث عن شيء محدد؟`
        : `The ${intentResult.category} category has many great products. Are you looking for anything specific?`;
      if (intentResult.items && intentResult.items.length > 0) {
        payload.text += '\n\n' + intentResult.items.slice(0, 4).map(i => `- ${getDisplayTitle(i, locale)}`).join('\n');
        payload.suggestions = intentResult.items.slice(0, 3).map(item => getDisplayTitle(item, locale));
      }
      break;
    case 'ecommerce_product_advantages': {
      const item = intentResult.item;
      const desc = getDisplayDescription(item, locale);
      const featureLines = buildFeatureLines(item, locale);
      const lines = [];
      if (desc) lines.push(desc);
      if (featureLines.length) lines.push(featureLines.join('\n'));
      payload.text = lines.length > 0 ? lines.join('\n\n') : (locale === 'ar' ? 'لا تتوفر تفاصيل إضافية لهذا المنتج.' : 'No additional details available for this product.');
      const thumb = getItemThumbnail(item);
      if (thumb) payload.thumbnail = thumb;
      payload.suggestions = [locale === 'ar' ? `اطلب ${getDisplayTitle(item, locale)}` : `Order ${getDisplayTitle(item, locale)}`];
      payload.context_update.last_item = item.id;
      break;
    }
    case 'item_found': {
      const item = intentResult.item;
      const title = getDisplayTitle(item, locale);
      const lines = [`**${title}**`];

      const category = getDisplayCategory(item, locale);
      const country = getDisplayCountry(item, locale);

      if (category) lines.push(locale === 'ar' ? `**القسم:** ${category}` : `**Category:** ${category}`);
      if (country) lines.push(locale === 'ar' ? `**البلد:** ${country}` : `**Country:** ${country}`);

      // Items reaching item_found are in stock, so confirm availability.
      lines.push(locale === 'ar' ? '✅ **متوفر للتوريد**' : '✅ **Available**');

      const description = getDisplayDescription(item, locale);
      if (description) {
        lines.push(`\n${description}`);
      }

      if (sourcing) {
        lines.push('\n' + sourcingPriceText(locale));
      } else if (item.price !== null && item.price !== undefined) {
        lines.push('\n' + (locale === 'ar' ? `**السعر:** ${item.price} ${item.currency}` : `**Price:** ${item.price} ${item.currency}`));
      }

      const featureLines = buildFeatureLines(item, locale);
      if (featureLines.length > 0) {
        lines.push('\n' + featureLines.join('\n'));
      }

      payload.text = lines.join('\n');
      const thumb = getItemThumbnail(item);
      if (thumb) {
        payload.thumbnail = thumb;
      }
      if (sourcing) addContactButton();

      payload.suggestions = locale === 'ar' ? [`اطلب ${title}`, 'المميزات'] : [`Order ${title}`, 'Advantages'];
      payload.context_update.last_item = item.id;
      payload.context_update.last_category = category || null;
      if (intentResult.country) payload.context_update.last_country = intentResult.countries || intentResult.country;
      break;
    }
    case 'item_sizes': {
      // AI pipeline [8] size/dimension question. Answer from the dimensions
      // metadata when present, else show the full product card.
      const item = intentResult.item;
      const title = getDisplayTitle(item, locale);
      const dims = resolveMetadataValue(item.metadata || {}, 'dimensions', locale)
        || resolveMetadataValue(item.metadata || {}, 'size', locale);
      if (dims) {
        payload.text = locale === 'ar'
          ? `${FEATURE_LABELS.ar.dimensions} لـ **${title}**: ${dims}`
          : `The ${FEATURE_LABELS.en.dimensions} of **${title}**: ${dims}`;
        const thumb = getItemThumbnail(item);
        if (thumb) payload.thumbnail = thumb;
        payload.context_update.last_item = item.id;
      } else {
        return buildResponse({ intent: 'item_found', item }, lang, business);
      }
      break;
    }
    case 'item_price': {
      const item = intentResult.item;
      const q = intentResult.quantity;
      const qtyLine = q
        ? (locale === 'ar' ? `\nللكمية ${q.qty} ${q.unit}: ` : `\nFor ${q.qty} ${q.unit}: `)
        : '';
      if (sourcing) {
        payload.text = `${getDisplayTitle(item, locale)}${qtyLine ? qtyLine : '\n'}${sourcingPriceText(locale)}`;
        addContactButton();
      } else {
        payload.text = item.price !== null && item.price !== undefined
          ? (locale === 'ar'
            ? `${getDisplayTitle(item, locale)} سعره ${item.price} ${item.currency}.`
            : `${getDisplayTitle(item, locale)} costs ${item.price} ${item.currency}.`)
          : (locale === 'ar'
            ? `سعر ${getDisplayTitle(item, locale)} غير محدد حالياً. تواصل معنا للتفاصيل.`
            : `The price for ${getDisplayTitle(item, locale)} is not listed yet. Please contact us for details.`);
        if (item.price === null || item.price === undefined) addContactButton();
      }
      const thumb = getItemThumbnail(item);
      if (thumb) payload.thumbnail = thumb;
      payload.suggestions = locale === 'ar' ? [`اطلب ${getDisplayTitle(item, locale)}`] : [`Order ${getDisplayTitle(item, locale)}`];
      payload.context_update.last_item = item.id;
      payload.context_update.last_category = getDisplayCategory(item, locale) || null;
      break;
    }
    case 'item_not_found':
      payload.text = locale === 'ar'
        ? 'لم أجد هذا المنتج في السوق حالياً، لكن يمكننا البحث عنه لك لدى شبكة الموردين — تواصل معنا أو تصفّح السوق كاملاً بالأسفل.'
        : 'I couldn’t find that product in the Marketplace right now, but we can search our supplier network for it — contact us or browse the full Marketplace below.';
      addMarketplaceButton();
      addContactButton();
      payload.suggestions = suggestions.slice(0, 3);
      break;
    case 'category_items':
      if (intentResult.items && intentResult.items.length > 0) {
        const heading = locale === 'ar' ? `إليك المنتجات في قسم ${intentResult.category}:` : `Here are the products in ${intentResult.category}:`;
        applyItemList(intentResult.items.slice(0, 6), heading);
        payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      } else {
        payload.text = locale === 'ar' ? `لا توجد منتجات في قسم ${intentResult.category} حالياً.` : `No products found in ${intentResult.category} category.`;
      }
      payload.context_update.last_category = intentResult.category;
      break;
    case 'list_categories':
      if (intentResult.categories && intentResult.categories.length > 0) {
        const heading = locale === 'ar' ? 'هذه هي الأقسام المتوفرة لدينا:' : 'Here are the categories we carry:';
        payload.text = [heading, ...intentResult.categories.map((name) => `- ${name}`)].join('\n');
        payload.suggestions = intentResult.categories.slice(0, 4);
      } else {
        payload.text = locale === 'ar' ? 'لا توجد أقسام مضافة حالياً.' : 'No categories are listed yet.';
      }
      addMarketplaceButton();
      break;
    case 'guided_discovery': {
      const tipsEn = [
        "No problem — here's how to pick with confidence, step by step:",
        '1. Start with a category — what is it broadly for?',
        "2. Tell me the use case (who it's for, where you'll use it) so I can narrow it down.",
        '3. Check price and available options (size/color) on the product card before you decide.',
        "4. Not sure between two? Ask me and I'll compare them for you.",
      ].join('\n');
      const tipsAr = [
        'ولا يهمك، هنختار المنتج المناسب مع بعض خطوة بخطوة:',
        '1. ابدأ باختيار القسم اللي المنتج منه.',
        '2. قولي هتستخدمه لإيه أو لمين عشان أقدر أضيّق الاختيار.',
        '3. راجع السعر والخيارات المتاحة (المقاس/اللون) في صفحة المنتج قبل ما تقرر.',
        '4. مش قادر تختار بين اتنين؟ اسألني وهقارنلك بينهم.',
      ].join('\n');
      if (intentResult.categories && intentResult.categories.length > 0) {
        const closing = locale === 'ar' ? 'بتدور على منتج في أي قسم من دول؟' : 'Which of these are you shopping for?';
        payload.text = `${locale === 'ar' ? tipsAr : tipsEn}\n\n${closing}`;
        payload.suggestions = intentResult.categories.slice(0, 8);
      } else {
        payload.text = locale === 'ar'
          ? 'ولا يهمك، هنساعدك. قولي بتدور على منتج لإيه أو لمين، ونضبطلك الاختيار.'
          : "No problem — we'll help. Tell me what the product is for or who it's for, and we'll narrow it down together.";
      }
      // Discovery has started — consume the kickoff flag so a later bare
      // "ok" doesn't loop the same tips again.
      payload.context_update.awaiting_discovery = false;
      addContactButton();
      break;
    }
    case 'item_disambiguation':
      if (intentResult.items && intentResult.items.length > 0) {
        const heading = locale === 'ar' ? 'وجدت أكثر من منتج مطابق. أي واحد تقصد؟' : 'I found more than one matching product. Which one did you mean?';
        applyItemList(intentResult.items.slice(0, 6), heading);
        payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      } else {
        payload.text = locale === 'ar' ? 'وجدت مطابقات متعددة ولكن لم نتمكن من عرض التفاصيل.' : 'Multiple matches found but details could not be loaded.';
      }
      break;
    case 'brand_info':
      payload.text = locale === 'ar'
        ? (business.about_ar || `نحن ${business.name_ar || business.name}. تواصل معنا إذا أردت معرفة المزيد.`)
        : (business.about_en || `We are ${business.name}. Contact us if you want to know more.`);
      break;
    case 'contact':
      payload.text = [
        locale === 'ar' ? 'يمكنك التواصل معنا عبر:' : 'You can contact us through:',
        business.phone ? (locale === 'ar' ? `الهاتف / واتساب: ${business.phone}` : `Phone / WhatsApp: ${business.phone}`) : null,
        business.email ? (locale === 'ar' ? `الإيميل: ${business.email}` : `Email: ${business.email}`) : null,
      ].filter(Boolean).join('\n') || (locale === 'ar' ? 'تواصل معنا عبر الزر بالأسفل.' : 'Reach us via the button below.');
      addContactButton();
      break;
    case 'working_hours':
      payload.text = locale === 'ar'
        ? (business.working_hours_ar ? `مواعيد العمل:\n${business.working_hours_ar}` : 'مواعيد العمل غير مضافة حالياً. تواصل معنا للتأكيد.')
        : (business.working_hours_en ? `Our working hours:\n${business.working_hours_en}` : 'Working hours are not listed yet. Please contact us to confirm.');
      break;
    case 'business_model':
      payload.text = locale === 'ar'
        ? `نعم ✅ منتجاتنا مناسبة للدروبشيبنج والبيع بالجملة وإعادة البيع. أسعار الجملة تختلف حسب الكمية — تواصل معنا ونرتّبلك التفاصيل والتوريد.`
        : `Yes ✅ our products are suited for dropshipping, wholesale, and reselling. Wholesale pricing varies with quantity — contact us and we'll sort out the details and sourcing.`;
      addContactButton();
      payload.suggestions = suggestions.slice(0, 3);
      break;
    case 'service_area': {
      const list = Array.isArray(intentResult.servedList) ? intentResult.servedList : [];
      const listText = list.join(locale === 'ar' ? '، ' : ', ');
      const named = intentResult.named;
      const namedLabel = named ? (locale === 'ar' ? (named.ar || named.en) : named.en) : '';

      if (!intentResult.hasCountryData) {
        // Catalog carries no country-of-origin data — answer from sourcing
        // stance rather than pretending a list exists.
        payload.text = locale === 'ar'
          ? `نوفّر ونشحن لمختلف الدول حسب المنتج — تواصل معنا لتأكيد توفّر دولتك.`
          : `We supply and ship to a range of countries depending on the product — contact us to confirm availability for your country.`;
        addContactButton();
      } else if (named && intentResult.isServed) {
        payload.text = locale === 'ar'
          ? `نعم ✅ نوفّر منتجات من ${namedLabel}. تقدر تسألني عن المنتجات المتوفرة منها.`
          : `Yes ✅ we do carry products from ${namedLabel}. Ask me about what's available from there.`;
      } else if (named && !intentResult.isServed) {
        payload.text = locale === 'ar'
          ? `حالياً لا نغطّي ${namedLabel}، لكن يمكننا توفير ما تحتاجه من شبكتنا — تواصل معنا. الدول المتوفرة حالياً: ${listText}.`
          : `We don't currently cover ${namedLabel}, but we can source what you need from our network — contact us. Countries we currently cover: ${listText}.`;
        addContactButton();
      } else {
        // General "which countries do you serve?" — list them.
        payload.text = locale === 'ar'
          ? `نوفّر منتجات من الدول التالية: ${listText}. لو تحتاج من دولة أخرى تواصل معنا ونوفّرها من شبكتنا.`
          : `We source products from: ${listText}. Need another country? Contact us and we'll source it from our network.`;
      }
      payload.suggestions = suggestions.slice(0, 3);
      break;
    }
    case 'location':
      payload.text = locale === 'ar'
        ? (business.address_ar ? `عنواننا:\n${business.address_ar}` : 'العنوان غير مضاف حالياً.')
        : (business.address_en ? `Our address:\n${business.address_en}` : 'Our address is not listed yet.');
      break;
    case 'unknown':
    default:
      payload.text = locale === 'ar'
        ? `سؤال جميل! عشان أضمنلك إجابة دقيقة، تقدر تتواصل مع فريقنا${business.phone ? ` على ${business.phone}` : ''} في أي وقت — وفي نفس الوقت اسألني عن أي منتج أو قسم أو سعر وهجاوبك فوراً.`
        : `Good question! To make sure you get an accurate answer, you can reach our team${business.phone ? ` at ${business.phone}` : ''} anytime — and meanwhile, ask me about any product, category, or price and I'll answer right away.`;
      payload.suggestions = suggestions.slice(0, 3);
      break;
  }

  return payload;
}

function mapSheetRecords(records) {
  return records
    .filter((record) => record.title || record.title_en || record.title_er || record.title_ar || record.name || record.name_en)
    .map((record) => {
      const standardKeys = [
        'title', 'title_en', 'title_ar', 'title_er', 'name', 'name_en', 'name_ar',
        'category', 'category_en', 'category_ar', 'category_er',
        'description', 'description_en', 'description_ar', 'description_er',
        'price', 'currency', 'available', 'availability', 'Metadata', 'metadata', 'METADATA'
      ];

      const rawMetadata = record.metadata || record.Metadata || record.METADATA || '';
      let metadataObj = {};
      if (rawMetadata) {
        try {
          metadataObj = typeof rawMetadata === 'object'
            ? rawMetadata
            : JSON.parse(rawMetadata);
        } catch (e) {
          console.error('[ecommerce mapSheetRecords] Failed to parse metadata json:', e.message);
        }
      }

      const lowerStandard = standardKeys.map(k => k.toLowerCase());
      for (const [k, v] of Object.entries(record)) {
        if (!lowerStandard.includes(k.toLowerCase()) && typeof v !== 'undefined') {
          metadataObj[k] = v;
        }
      }

      if (record.thumbnail || record.thumbnail_url || record.image) {
        metadataObj.thumbnail = record.thumbnail || record.thumbnail_url || record.image;
      }
      if (record.hot_selling !== undefined) {
        metadataObj.hot_selling = ['1', 'true', 'yes', true].includes(record.hot_selling);
      }
      if (record.country_en || record.country) {
        metadataObj.country_en = record.country_en || record.country;
      }
      if (record.country_ar) {
        metadataObj.country_ar = record.country_ar;
      }

      return {
        title_en: record.title_en || record.title || record.name_en || record.name || '',
        title_ar: record.title_ar || record.title_er || record.name_ar || '',
        category_en: record.category_en || record.category || '',
        category_ar: record.category_ar || record.category_er || '',
        description_en: record.description_en || record.description || '',
        description_ar: record.description_ar || record.description_er || '',
        price: record.price ? Number(record.price) : null,
        currency: record.currency || 'EGP',
        metadata: JSON.stringify(metadataObj),
        available: toAvailable(record),
      };
    });
}

// The catalog JSON uses `availability` (boolean); legacy/sheets use `available`.
// Default to available when the field is absent so a missing flag never hides a
// product. Recognizes common falsey spellings in EN and AR.
function toAvailable(record) {
  const raw = record.availability !== undefined ? record.availability
    : (record.available !== undefined ? record.available : true);
  if (raw === true || raw === 1) return 1;
  const s = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'out', 'out of stock', 'unavailable', 'غير متوفر', 'غير متاح', 'نفذ', 'نفذت'].includes(s)) return 0;
  return 1;
}

module.exports = {
  serviceType: 'ecommerce',
  defaultSheetName: 'Products',
  defaultBusinessName: 'New E-Commerce Store',
  detectIntent,
  buildResponse,
  getWelcomeMessage(business, lang) {
    return lang === 'ar'
      ? (business.welcome_ar || `أهلاً بك في متجر ${business.name_ar || business.name}!`)
      : (business.welcome_en || `Welcome to ${business.name} store!`);
  },
  mapSheetRecords,
};
