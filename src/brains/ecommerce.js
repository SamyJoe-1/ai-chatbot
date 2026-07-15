'use strict';

const { tokenize, normalize, isPureThanksMessage } = require('../engine/detector');
const { getBusinessItems, getAllBusinessItems } = require('./shared/catalogStore');
const { findMatchingCategories, findScoredItems, uniqueById, uniqueScoredByTitle, detectCountry, detectCountries, detectAnyKnownCountry, countryCanonicalId, countryMatchesItem } = require('./shared/matcher');
const { getItemThumbnail, buildThumbnailMessages } = require('./shared/thumbnailMessages');
const { matchFaq, parseFaqList } = require('../engine/faqMatcher');

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
    brand_info: [/\bwho are you\b/i, /\babout you\b/i, /\babout the store\b/i, /\bwhat do you (provide|offer|sell|do)\b/i, /\bwhat( are|'?s)? your services?\b/i, /\bwhat services\b/i, /\byour services?\b/i],
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
    ecommerce_search_hot: [
      /\bhot\b/i,
      /\bbest[\s-]?sell(ing|ers?)\b/i,
      /\bbestsellers?\b/i,
      /\bpopular\b/i,
      /\btop[\s-]?sell(ing|ers?)\b/i,
      /\btop[\s-]?rated\b/i,
      /\bmost[\s-]?sold\b/i,
      /\bmost[\s-]?(popular|wanted|ordered|bought|demanded)\b/i,
      /\b(in[\s-]?)?high[\s-]?demand\b/i,
      /\bhighest[\s-]?(sell(ing|ers?)|demand)\b/i,
      /\bnumber\s*one\b/i,
      /\btop\s*(pick|choice)\b/i,
      /\bfan\s*favorite\b/i,
      // Bare superlative + product noun ("best product you have", "greatest
      // items") — same rule as the Arabic list: "best" only ever means the
      // owner's hot_selling flag, never an AI-invented ranking.
      /\b(best|greatest|finest|top)\b[\w\s]{0,20}\b(product|item|thing|option)s?\b/i,
      /\bcustomers?('s)?\s*favorite\b/i,
      /#\s*1\b/,
      /\bmost\s+sought[\s-]?after\b/i,
    ],
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
    // "what product were we talking about?" / "check the chat" — asks the bot to
    // RECALL the conversation subject. Answered from the item already in context.
    recall_topic: [
      /\bwhat (product|item|one)\b[^?]*\bwe(re| are| just)?\b[^?]*\b(talk|discuss|say|about|mention)/i,
      /\bwhich (product|item|one) (were|are|was) we\b/i,
      /\b(check|read|scroll up|look at|re-?read) (the|our) (chat|conversation|messages|history)\b/i,
      /\bthe (product|item|one) (we|i) (were|was|just)\b/i,
    ],
    // "which countries do you serve / do you ship to X / where do you operate" —
    // a SERVICE-AREA question (not opening hours, not a product filter). Kept
    // ahead of working_hours in detectIntent so "do you work in Morocco" never
    // gets answered with business hours.
    service_area: [
      // "what/which ... countries" — tolerate filler words in between so
      // "what fuckin countries", "what about countries", "which exact countries"
      // all still read as a service-area question, not fall through to unknown.
      /\b(which|what)\b(?:\s+\w+){0,4}\s+countr(y|ies)\b/i,
      /\bcountr(y|ies)\b(?:\s+\w+){0,4}\s+(do|are|you|ur|u|working|work|operate|ship|serve|cover|deliver|source)\b/i,
      /\bcountries (do|are) you\b/i,
      /\bdo you (work|operate|sell|ship|deliver|serve|source|export|cover|reach|have anything)\s+(in|to|from|out)\b/i,
      /\bdo you (ship|deliver|export)\s+(to|internationally|abroad|worldwide)\b/i,
      /\bwhere (do|are) you (operate|operating|based|located|ship|shipping|work|working|source|sourcing)\b/i,
      /\b(work|operate|available|present|sell|ship)\s+in\s+(which|what)\s+countr/i,
    ],
    // Verb of presence/operation — combined with a recognized country name (or a
    // bare "countries" topic word, see detectIntent) to catch "do you work in
    // <country>" / "what countries ur working at". Stems (no trailing \b) so
    // inflections match: work/working/works, operate/operating, ship/ships/shipping.
    service_area_verb: [/\b(work|operat|sell|ship|deliver|serv|sourc|export|present|availab|based|locat|reach|cover)/i],
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
    item_price: [/\bprice\b/i, /\bcost\b/i, /\bhow much\b/i, /\bquote\b/i, /\bwholesale\b/i, /\b(expensive|cheap|affordable|pricey|pricy|budget)\b/i, /\bhow (expensive|cheap)\b/i, /\bprice range\b/i, /\bworth it\b/i, /\b\d{1,7}\s*(pcs?|pieces?|units?|dozen|cartons?|boxes?|kg)\b/i],
    // Stock-COUNT question ("how many in stock / how many do you have"). We never
    // publish exact counts, so this gets a clear canned answer, not a "which
    // product?" runaround. A price word present means it's a price question.
    stock_quantity: [/\bhow many\b[^?]*\b(in stock|available|left|do you have|units?|pieces?|pcs)\b/i, /\b(in stock|stock (level|count|quantity)|units? available|pieces? available|quantity available|qty available)\b/i],
    // MINIMUM order quantity (MOQ) — a POLICY question ("what's the least I
    // can order"), a different concept from stock_quantity ("how many do you
    // HAVE"). No product name required; answered upfront and deterministically
    // (never sent to the AI) so it can't get hijacked into an order-flow
    // "which product?" prompt.
    moq: [/\b(minimum|min\.?|least|smallest|lowest|maximum|max\.?|most|largest|highest)\b[\w\s]{0,20}\b(order|quantity|qty|amount|purchase)\b/i, /\bmoq\b/i, /\bhow (many|much)\b[\w\s]{0,15}\b(minimum|maximum|at least|at most|up to|to order|can i order)\b/i, /\b(quantity|qty)\b[\w\s]{0,15}\b(limit|cap)\b/i],
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
    brand_info: [/(من انتم|مين انتم|نبذه عنكم|نبذة عنكم|من انتو|ماذا تقدمون|عن المتجر|عن المعرض|مين انت|خدمات|خدمتكم|وش تقدمون|ايش تقدمون|بتقدموا ايه|بتقدموا إيه|بتعملوا ايه|بتعملوا إيه|شغلكم ايه|شغلكم إيه|طبيعه عملكم|طبيعة عملكم|بتبيعوا ايه|بتبيعوا إيه|بتوفروا ايه|بتوفروا إيه|ايه اللي بتقدموه|إيه اللي بتقدموه)/],
    // "احنا كنا بنتكلم علي منتج ايه" / "راجع الشات وهتعرف احنا بنتكلم علي انهي
    // منتج" — recall the product under discussion from context instead of asking
    // the customer which product (which loops infuriatingly).
    recall_topic: [
      /(كنا بنتكلم|احنا بنتكلم|بنتكلم عن اي|بنتكلم علي اي|بنتكلم علي منتج|بنتكلم عن منتج|بنحكي عن)/,
      /(انهي منتج|اي منتج كنا|اي منتج احنا|المنتج اللي كنا|المنتج اللي فات|المنتج اللي قبل)/,
      /(راجع الشات|راجع المحادثه|راجع المحادثة|شوف الشات|اقرا الشات|اقرأ الشات|ارجع للرسائل|فوق الرسائل|اللي فوق)/,
    ],
    catalog_general: [/(كتالوج|ايش عندكم|شو عندكم|عندكم ايه|عندك ايه|الكتالوج|وش عندكم)/],
    catalog_general_generic: [/(المنتجات|السوق|الماركت|المتجر|منتجاتكم|كل منتجاتكم|جميع منتجاتكم|منتجاتكو)/],
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
    // "most/more selling/demanded" in any colloquial spelling: اكتر/اكثر/اعلى
    // (also inside الاكثر/الاعلى) + بيع/مبيع/مبيعا/مبيعات/طلب/طلبا, so "اكتر بيع"
    // (Gulf/Egyptian "more selling") lands the same as formal "الأكثر مبيعاً".
    // Up to 3 words are allowed BETWEEN the two (e.g. "اكثر منتج مبيعا" = "most
    // PRODUCT sold") — the noun in between must not defeat the match.
    ecommerce_search_hot: [
      /(اكتر|اكثر|اعلي)(?:\s+\S+){0,3}?\s+(بيع|مبيع|مبيعا|مبيعات|طلب|طلبا)/,
      /(بيست\s*سيلر|بست\s*سيلر|ساخن|مشهور|مطلوب|الاكثر رواجا|الاكثر انتشارا|رايج|رايجه)/,
      /(الافضل مبيعا|الافضل بيعا|احسن حاجه بتتباع|احسن منتج بيع|اشهر منتج|اشهر حاجه|الاكثر شعبيه)/,
      /(منتج رقم واحد|رقم واحد في المبيعات)/,
      // Bare superlative + product noun ("افضل منتج", "احسن منتجات عندكم") —
      // the ONLY honest source for "best" is the owner's hot_selling flag, so
      // this must resolve locally, never let the AI invent a ranking. منت[جح]
      // tolerates the common ج/ح typo ("منتح"); حاج[ةه] covers dialect "حاجه".
      /(افضل|احسن|اجمد|اقوي)(?:\s+\S+){0,2}?\s*(منت[جح]|منتجات|حاج[ةه]|خيار|اختيار)/,
    ],
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
    item_price: [/(سعر|اسعار|أسعار|بكام|بكم|بقديش|كم السعر|الثمن|حسابه|حسابها|كم حقها|حقها كم|عرض سعر|الجمله|الجملة|غالي|غاليه|غالية|رخيص|رخيصه|رخيصة|مناسب السعر|في المتناول|\d{1,7}\s*(حبة|حبه|قطعة|قطعه|قطع|علبة|علبه|كرتون|كرتونه|كرتونة|درزن|دستة|دسته|طن|كيلو))/],
    // Stock-COUNT question: "فيه منه كام حبة"، "كام قطعة متوفرة"، "العدد المتاح".
    // We hold no per-item stock count — only an availability flag — so naming the
    // product changes nothing. Answered upfront instead of asking "which product?".
    // Bare "كمية"/"الكمية" (no ال/متوفرة needed) must ALSO resolve here — a
    // one-word follow-up like "كمية" after discussing an item used to match
    // NOTHING (neither this nor the FAQ's longer "ما الكمية المتوفرة" phrasing)
    // and fell through to a generic unrelated AI reply instead of answering.
    stock_quantity: [/(منه كام|منها كام|فيه منه|فيه منها|في منه|كام حبة|كم حبة|كام حبه|كم حبه|كام قطعة|كم قطعة|كام قطعه|كام واحد|كم العدد|العدد المتاح|الكميه المتاحه|الكمية المتاحة|كميه متوفره|كمية متوفرة|كام متوفر|متوفر كام|متوفر منه كام|المخزون|بالمخزون|عندكم كام|كام عندكم|الاستوك|ستوك)/, /^(كميه|الكميه)[?؟!.\s]*$/],
    // MINIMUM order quantity (MOQ) — "اقل كمية يمكنني طلبها؟" is a POLICY
    // question, not a stock-count question (stock_quantity above). No \b
    // around the Arabic words — Arabic letters aren't \w, \b never fires there.
    // Covers BOTH directions: minimum ("اقل كمية") and maximum ("اقصى كمية
    // ممكن اطلبها") — a limit question either way, answered as policy, never
    // turned into an order. Normalized text: hamza forms collapse to ا and
    // ى -> ي, so only the normalized spellings are needed here.
    moq: [/(اقل كمي[ةه]|اقل عدد|الحد الادني|حد ادني|من كم قطعه يبدا|من كام قطعه يبدا|اقل طلبي[ةه]|اصغر طلبي[ةه])/, /(اقصي|اكبر|اعلي)\s*(كمي[ةه]|عدد)/, /(الحد الاقصي|حد اقصي)/, /(كمي[ةه]|عدد)[^؟?]{0,15}(ممكن|يمكن|اقدر|نقدر)[^؟?]{0,10}(اطلب|طلب)/],
    logistics_inquiry: [/(كم يوم|كم يومًا|كم يوماً|امتى|متى يوصل|كم مدة|وقت التوصيل|وقت الشحن|وقت التوريد|المخزن|المستودع|مدة التوريد|مدة الشحن|التسليم|فترة التوريد|هيوصل امتى|يوصل امتى|تاريخ التسليم)/],
  }
};

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

// "Hot/best selling" must fire regardless of which single language
// detectLanguage() picked for the WHOLE message. A mixed message like "best
// selling في السعودية" is classified 'ar' overall (Arabic-char ratio wins),
// so only patterns.ar would normally be tested and the English phrase would be
// silently dropped -> the query falls through to an unfiltered country list
// (hot AND non-hot mixed together). Test both language pattern sets, always.
// Common customer words for a category that don't literally appear in the
// catalog's category names ("منتجات تجميل" -> "الجمال والعناية", "cosmetics" ->
// "Beauty & Personal Care"). Each alias maps to normalized keywords tested
// against the item's own category names, so it works across brands without
// hardcoding any one catalog. Extend as misses show up in the logs.
const CATEGORY_ALIASES = [
  { re: /(تجميل|مكياج|ميكب|كوزمتك|مستحضرات)|\b(cosmetics?|make\s?up|skin\s?care)\b/i, keys: ['جمال', 'عناي', 'beauty'] },
  { re: /(موبايل|جوال|تليفون)|\b(mobiles?|cell\s?phones?)\b/i, keys: ['هواتف', 'phone'] },
  { re: /(ملابس|لبس|هدوم)|\b(clothes|clothing|apparel|wear)\b/i, keys: ['ازياء', 'fashion'] },
  { re: /(عطور|عطر|برفان)|\b(perfumes?|fragrances?)\b/i, keys: ['عطور', 'perfume'] },
  { re: /(رياض[ةه]|جيم)|\b(sports?|fitness|gym)\b/i, keys: ['رياض', 'sport'] },
  { re: /(اطفال|بيبي)|\b(kids?|bab(y|ies)|children)\b/i, keys: ['اطفال', 'baby', 'kids'] },
];

// Resolve a category from an alias word when the literal category matcher
// found nothing. Returns { display, items } or null.
function findCategoryByAlias(normalizedText, items, lang) {
  for (const alias of CATEGORY_ALIASES) {
    if (!alias.re.test(normalizedText)) continue;
    const hits = items.filter((item) => {
      const names = [normalize(item.category_ar || '', 'ar'), normalize(item.category_en || '', 'en')];
      return alias.keys.some((key) => names.some((n) => n && n.includes(normalize(key, lang === 'ar' ? 'ar' : 'en'))));
    });
    if (hits.length) {
      return { display: getDisplayCategory(hits[0], lang), items: hits };
    }
  }
  return null;
}

function matchesHotSelling(normalizedText) {
  return matchesAny(normalizedText, PATTERNS.en.ecommerce_search_hot)
    || matchesAny(normalizedText, PATTERNS.ar.ecommerce_search_hot);
}

// Same bilingual gap as matchesHotSelling — "MOQ" is commonly typed in Latin
// even inside an otherwise-Arabic message ("كام ال MOQ بتاعكم"), which
// detectLanguage() still classifies as 'ar' overall, so only patterns.ar
// would normally be tested and the English/acronym form silently missed.
function matchesMoq(normalizedText) {
  return matchesAny(normalizedText, PATTERNS.en.moq)
    || matchesAny(normalizedText, PATTERNS.ar.moq);
}

// A superlative ("the MOST/TOP/best-selling X") paired with a SINGULAR noun
// ("منتج"/"product", not "منتجات"/"products") asks for exactly the #1 item —
// the same as an explicit "one"/"واحد" request, just phrased implicitly. Kept
// separate from single_item_request (which only fires on the literal word
// "one"/"واحد") so "اكثر منتج مبيعا" caps to 1 result without needing "واحد" too.
function wantsSingleFromSuperlative(text) {
  const value = String(text || '');
  if (/\b(top|best[\s-]?sell(?:ing|er)|most[\s-]?sold|number\s*one|#\s*1)\b[\w\s]{0,20}\bproduct\b(?!s)/i.test(value)) return true;
  if (/\bproduct\b(?!s)[\w\s]{0,20}\b(top|best[\s-]?sell(?:ing|er)|most[\s-]?sold)\b/i.test(value)) return true;
  // Bare "best product" (singular) — same implicit "just the #1" ask.
  if (/\b(best|greatest|finest)\b[\w\s]{0,15}\b(product|item)\b(?!s)/i.test(value)) return true;
  // No \b here — Arabic letters aren't \w, so \b silently never fires around
  // them (same trap detector.js's dialect matchers already work around).
  // (?!ات) alone is enough to exclude the plural "منتجات".
  const norm = normalize(value, 'ar');
  if (/(اكتر|اكثر|اعلي)(?:\s+\S+){0,2}?\s*منتج(?!ات)[\s\S]{0,20}(بيع|مبيع|مبيعا|طلب|طلبا)/.test(norm)) return true;
  if (/منتج(?!ات)[\s\S]{0,20}(اكتر|اكثر|اعلي)[\s\S]{0,20}(بيع|مبيع|مبيعا|طلب|طلبا)/.test(norm)) return true;
  // Bare "افضل/احسن منتج" (singular, منت[جح] tolerates the ج/ح typo) — the #1
  // hot-selling item, one card, not a list.
  if (/(افضل|احسن|اجمد|اقوي)(?:\s+\S+){0,2}?\s*منت[جح](?!ات)/.test(norm)) return true;
  return false;
}

// "give me 3 products" / "3 منتجات بس" — an EXPLICIT sample size, distinct
// from single_item_request (always exactly 1) and from a plain list request
// (no count named, default display cap applies). Without this, "قلي 3
// منتجات بس من اللي عندكم" matches NO local pattern at all (no item, no
// category, no "المنتجات" — just a bare count + "منتجات") and falls through to
// the AI classifier, which has no rule for it either and can land on a
// random unrelated item's detail instead of a product list.
function extractRequestedProductCount(normalizedText) {
  const value = String(normalizedText || '');
  const capValid = (n) => (Number.isFinite(n) && n > 0 && n <= 20 ? n : null);
  // Digit + a generic "product" noun always counts ("3 منتجات", "3 products").
  const genericMatch = value.match(/(\d{1,3})\s*(منتج|منتجات|قطعة|قطعه|قطع|حاجة|حاجه|حاجات|صنف|اصناف|أصناف|products?|items?)/i);
  if (genericMatch) {
    const n = capValid(Number(genericMatch[1]));
    if (n) return n;
  }
  // Digit + a CATEGORY-shaped word ("3 عطور") only counts when paired with a
  // restrictive "only/just" word — that confirms it's a count request and not
  // a stray number elsewhere in the message (a wholesale unit count, a price,
  // a phone digit, ...).
  // No \b around the Arabic alternatives — Arabic letters aren't \w, so \b
  // silently never fires around them (same recurring trap as elsewhere here).
  if (/(بس|فقط)|\b(only|just)\b/i.test(value)) {
    const restrictiveMatch = value.match(/(\d{1,3})\s*[؀-ۿa-zA-Z]+/);
    if (restrictiveMatch) {
      const n = capValid(Number(restrictiveMatch[1]));
      if (n) return n;
    }
  }
  return null;
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

// Finds an owner-authored FAQ entry that is ITSELF about the given country —
// matched by running the SAME typo-tolerant country detector against the
// FAQ's own question text, not by generic keyword overlap. This deliberately
// bypasses matchFaq()'s word-overlap matching: that system has no Arabic
// stemming (a verb like "تبحثه" never lines up with a noun like "البحث" in the
// FAQ text) and no typo tolerance, so a colloquial/misspelled capability
// question ("تقدره تبحثه عن منتجات في لبيا") would never clear its overlap
// threshold even though the COUNTRY itself was resolved correctly. Grounding
// the match in the country — the one fact both sides agree on — is far more
// reliable than comparing loose wording.
function findCountryCapabilityFaq({ business, lang, country, items }) {
  const faqList = parseFaqList(lang === 'ar' ? business.faq_ar : business.faq_en);
  for (const entry of faqList) {
    const q = String(entry.q || entry.question || '').trim();
    const a = String(entry.a || entry.answer || '').trim();
    if (!q || !a) continue;
    const faqCountries = detectCountries(q, lang, items);
    if (faqCountries.includes(country)) return { question: q, answer: a };
  }
  return null;
}

function isSourcing(business) {
  return Number(business && business.sourcing_mode) === 1;
}

// Price / quantity disclosure. Default ENABLED — a missing/undefined flag (older
// business row) keeps the old behavior. When disabled, the bot must NEVER quote
// or fish for a price/qty; a price/qty question gets a hard "we don't disclose
// that here" (availability only), and product cards drop the price/quote line.
function isPriceEnabled(business) {
  return Number(business && business.price_enabled) !== 0;
}
function isQtyEnabled(business) {
  return Number(business && business.qty_enabled) !== 0;
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

// Hard "prices aren't disclosed here" line — used when price display is turned
// OFF. Focuses on availability, never invites a quote or asks which product.
function priceDisabledText(locale, name) {
  if (locale === 'ar') {
    return name
      ? `**${name}** متوفر ✅. لكن لا نعرض الأسعار عبر الشات — للاستفسار عن السعر تواصل معنا مباشرة.`
      : 'لا نعرض الأسعار عبر الشات — تواصل معنا مباشرة وسنساعدك.';
  }
  return name
    ? `**${name}** is available ✅. We don't display prices in chat — please contact us directly for pricing.`
    : "We don't display prices in chat — please contact us directly and we'll help.";
}

// Hard "stock quantities aren't disclosed here" line — used when quantity
// display is turned OFF. Availability only, no invitation to state a quantity.
function qtyDisabledText(locale, name) {
  if (locale === 'ar') {
    return name
      ? `**${name}** متوفر ✅. لكن لا نعرض الكميات المتاحة عبر الشات — للاستفسار تواصل معنا مباشرة.`
      : 'لا نعرض الكميات المتاحة عبر الشات — تواصل معنا مباشرة وسنساعدك.';
  }
  return name
    ? `**${name}** is available ✅. We don't share stock quantities in chat — please contact us directly.`
    : "We don't share stock quantities in chat — please contact us directly.";
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

// Boolean STATUS attributes people ask about with a yes/no question ("is it a
// best seller?", "is it available?", "is it new/trending?"). Each entry maps the
// question wording -> the item test that answers it. Kept separate from
// detectFeatureInquiry (which dumps a "The X of Y is: value" line and SKIPS
// hot_selling as an internal key) because these expect a terse yes/no, NOT a
// field dump and NOT the hot-selling LIST.
const STATUS_YESNO_GROUPS = [
  {
    key: 'hot_selling',
    re: [/\bhot[\s_-]?sell/i, /\bbest[\s_-]?sell/i, /\bbest[\s_-]?seller/i, /\bbestsell/i, /\btop[\s_-]?sell/i, /\btop[\s_-]?seller/i],
    reAr: [/الاكثر مبيعا|اكثر مبيعا|الاكثر طلبا|اكثر طلبا|بيست سيلر|بيست سلر|الافضل مبيعا/],
    test: (item) => isHotSelling(item),
    // "what's top selling in <country>/<category>?" is a SEARCH request, not a
    // yes/no fact-check about whatever item happens to be in context — without
    // this, "whats top selling beauty in saudi" answered "no, <some random
    // contextual item> isn't a best-seller" instead of running the search.
    skipWhenCountry: true,
    skipWhenCategory: true,
  },
  {
    key: 'available',
    re: [/\bavailable\b/i, /\bin stock\b/i, /\bavailability\b/i],
    reAr: [/متوفر|متاح|موجود|بالمخزون|في المخزن/],
    test: (item) => Number(item.available) === 1 || item.available === true,
    // "is it available in <country>?" is a country question, not a stock yes/no.
    skipWhenCountry: true,
  },
  { key: 'new', re: [/\bnew\b/i], reAr: [/جديد|الجديد/], test: (item) => itemBadge(item).includes('new') },
  { key: 'trending', re: [/\btrending\b/i, /\btrend\b/i], reAr: [/رائج|الرائج|ترند|تريند/], test: (item) => itemBadge(item).includes('trending') },
  { key: 'limited', re: [/\blimited\b/i], reAr: [/محدود/], test: (item) => itemBadge(item).includes('limited') },
];

// Interrogative shape: begins with a yes/no auxiliary, or explicitly says "or
// not" / ends with "?" / Arabic "هل"/"ولا"/"مش" — so a plain LIST request
// ("hot selling products", "show me new arrivals") with a stale item in context
// is never mistaken for a yes/no about that item.
function looksLikeYesNoQuestion(normalizedText, rawText) {
  const t = String(normalizedText || '').trim();
  const r = String(rawText || '');
  return /^(is|are|does|do|did|was|were|has|have|it'?s|isn'?t|are'?nt)\b/i.test(t)
    || /\bor not\b/i.test(t)
    || /\?\s*$/.test(r)
    || /(^|\s)هل(\s|$)/.test(r)
    || /(^|\s)(ولا|مش|هو|هي|هوه|هيه)(\s|$)/.test(r);
}

// Yes/no about ONE resolved product's boolean status. Returns an intent the
// handler renders as a terse "Yes ✅ …" / "No — …", or null.
function detectStatusYesNo(normalizedText, rawText, lang, item, categoryNamed) {
  if (!item) return null;
  if (!looksLikeYesNoQuestion(normalizedText, rawText)) return null;
  const countryNamed = Boolean(detectAnyKnownCountry(rawText, lang));
  for (const g of STATUS_YESNO_GROUPS) {
    if (g.skipWhenCountry && countryNamed) continue;
    if (g.skipWhenCategory && categoryNamed) continue;
    // Latin keys are allowed in either chat language (users type "best seller"
    // in Latin even mid-Arabic); Arabic keys only when the chat is Arabic.
    const hit = g.re.some((re) => re.test(normalizedText))
      || (lang === 'ar' && (g.reAr || []).some((re) => re.test(rawText)));
    if (hit) {
      return { intent: 'ecommerce_status_yesno', item, statusKey: g.key, statusValue: Boolean(g.test(item)) };
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
  if (matchesAny(normalizedText, patterns.thanks) && isPureThanksMessage(normalizedText, patterns.thanks)) return { intent: 'thanks' };

  // "X in every country" ("عطر في كل بلد", "a perfume in each country") -> ONE X
  // per served country, NOT a single item's origin. Must run before the item /
  // feature-inquiry logic, which would otherwise collapse "عطر" to one perfume
  // and read "بلد" as a country-of-origin question about it.
  const PER_COUNTRY_RE = lang === 'ar'
    ? /(كل|جميع|كافه|كافة)\s*(بلد|دوله|دولة|الدول|البلاد|بلاد|دول)|من\s*كل\s*(بلد|دوله|دولة|دول)/
    : /\b(every|each|all)\s+countr(y|ies)\b|\bper country\b/i;
  if (PER_COUNTRY_RE.test(normalizedText)) {
    // Isolate the SUBJECT ("عطر"/"perfume") by stripping the "per country" phrase
    // and command fillers — otherwise "perfume in every country" scores 0 against
    // the catalog (the extra tokens don't match any item) and nothing resolves.
    const subjectText = String(text)
      .replace(lang === 'ar'
        ? /(في|من)?\s*(كل|جميع|كافه|كافة)\s*(بلد|دوله|دولة|الدول|البلاد|بلاد|دول)/g
        : /\b(in|from)?\s*(every|each|all)\s+countr(y|ies)\b|\bper country\b/gi, ' ')
      .replace(lang === 'ar'
        ? /(طلعلي|طلع لي|هاتلي|هات لي|قلي|قوللي|قول لي|اعرضلي|اعرض لي|اعرض|وريني|ورني|عايز|عاوز|بدي|اريد|أريد|ابغى|ابغي|اعطني|اعطيني|جيبلي|جيب لي)/g
        : /\b(show|give|get|bring|find|tell)\s+me\b|\ba\b|\ban\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // A GENERIC subject ("منتج"/"product"/"anything") or an empty one means "any
    // product per country" — pool = the whole catalog, no category filter.
    const GENERIC_SUBJECT_RE = lang === 'ar'
      ? /^(منتج|منتجات|حاجه|حاجة|شي|شيء|صنف|اصناف|أصناف|اي\s*(حاجه|شي)|أي\s*(حاجة|شيء))$/
      : /^(product|products|item|items|something|anything|good|goods)$/i;
    let pool = [];
    let subjectLabel = null;
    if (!subjectText || GENERIC_SUBJECT_RE.test(subjectText)) {
      pool = items;
      subjectLabel = null;
    } else {
      const subj = findEcommerceItems(subjectText, lang, business.id, context);
      if (subj.categoryMatches.length) {
        pool = subj.categoryMatches[0].items;
        subjectLabel = subj.categoryMatches[0].display;
      } else if (subj.matchedItems.length) {
        const topCat = String(subj.matchedItems[0].category_en || subj.matchedItems[0].category_ar || '').trim();
        pool = topCat
          ? items.filter((i) => String(i.category_en || i.category_ar || '').trim() === topCat)
          : subj.matchedItems;
        subjectLabel = getDisplayCategory(subj.matchedItems[0], lang);
      }
    }
    if (pool.length) {
      const served = getServedCountries(items, lang);
      const groups = [];
      for (const country of served) {
        const pick = pool.find((it) => countryMatchesItem(it, country));
        if (pick) groups.push({ country, item: pick });
      }
      if (groups.length) return { intent: 'ecommerce_per_country', groups, subjectLabel };
    }
  }

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

  // "What product were we talking about?" / "راجع الشات" — recall the subject
  // from context. Resolve the item from last_item (or the most recent tracked
  // item) and NAME it, instead of looping "which product did you mean?".
  if (matchesAny(normalizedText, patterns.recall_topic)) {
    const recallId = Number.isFinite(context.last_item)
      ? context.last_item
      : (Array.isArray(context.recent_item_ids) && context.recent_item_ids.length
        ? context.recent_item_ids[context.recent_item_ids.length - 1]
        : null);
    const recalled = recallId ? items.find((i) => i.id === recallId) : null;
    return { intent: 'recall_topic', item: recalled || null };
  }

  // "Do you speak Gulf/Egyptian dialect?" — a LANGUAGE meta question. Must be
  // caught BEFORE any country/region logic: the dialect adjective ("خليجي")
  // contains the region word خليج, so without this guard it substring-matches
  // the Gulf region group and dumps that region's products — a language
  // question answered with a product list. Gated on a dialect/speak signal so
  // ordinary product messages never land here.
  const LANG_NOUN_RE = /(لهجه|اللهجه|dialect)/;
  const SPEAK_VERB_RE = /(تتكلم|بتتكلم|تحكي|بتحكي|اتكلم|تكلمني|كلمني|do you speak|speak)/;
  const DIALECT_NAME_RE = /(خليجي|خليجيه|مصري|مصريه|شامي|شاميه|لبناني|سوري|اردني|بدوي|عربي فصيح|فصحى|انجليزي|انقلش|english|arabic|egyptian|gulf|levantine)/;
  if (!foundItem && (LANG_NOUN_RE.test(normalizedText)
    || (SPEAK_VERB_RE.test(normalizedText) && DIALECT_NAME_RE.test(normalizedText)))) {
    const named = normalizedText.match(/(خليجي|خليجيه|gulf)/) ? 'gulf'
      : normalizedText.match(/(مصري|مصريه|egyptian)/) ? 'egyptian'
      : normalizedText.match(/(شامي|شاميه|لبناني|سوري|اردني|levantine)/) ? 'levantine'
      : normalizedText.match(/(انجليزي|انقلش|english)/) ? 'english'
      : null;
    return { intent: 'language_meta', namedDialect: named };
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
  // A bare "countries" / "دول" topic word plus an operation verb ("countries ur
  // working at", "دول بتشتغلوا فيها") is a service-area question even when no
  // specific country is named and the fixed patterns above don't fire. Excluded
  // when the message is a product-country FILTER ("products available in my
  // country") so that path still shows items rather than the served list.
  const mentionsCountryTopic = /\bcountr(y|ies)\b/i.test(normalizedText)
    || /(^|\s)(دول|دوله|دولة|بلد|بلاد|بلدان)(\s|$|كم|ان)/.test(normalizedText);
  const isProductCountryFilter = /\b(products?|items?)\b/i.test(normalizedText)
    || /(منتج|منتجات|سلعه|سلعة|سلع|صنف|اصناف|أصناف)/.test(normalizedText);
  // "best seller / best selling / top seller in <country>" is a HOT-PRODUCT query,
  // not a coverage question — but "seller"/"selling" hit the "sell" service-area
  // verb. Exclude it so it flows to the ecommerce_search_hot handler below.
  const looksLikeHotQuery = matchesHotSelling(normalizedText);
  const verbGate = !isProductCountryFilter && !looksLikeHotQuery;

  // Item ORIGIN ("where is it from?", "what country is X from?", "made in?") ->
  // the PRODUCT's own country, NOT the served-countries list. "what country"
  // also matches the service_area pattern, so resolve this FIRST — but only when
  // we have a specific item (named this turn or in context) and NO other country
  // is named (a named country makes it a coverage/filter question instead).
  const originItemRef = foundItem
    || (Number.isFinite(context.last_item) ? items.find((i) => i.id === context.last_item) : null)
    || (Array.isArray(context.recent_item_ids) && context.recent_item_ids.length
      ? items.find((i) => i.id === context.recent_item_ids[context.recent_item_ids.length - 1]) : null);
  const asksOrigin = lang === 'ar'
    ? /(منين|من وين|من اي بلد|من أي بلد|من اي دوله|من أي دولة|بلد المنشا|بلد المنشأ|المنشا|المنشأ|صنع فين|مصنوع فين|جايه منين|بيجي منين|بتيجي منين|انهي دوله|انهي دولة|إنهي دوله|إنهي دولة|اي دوله اصلا|أي دولة اصلا|دولته|دولتها|بلده اي|بلدها اي|بلده ايه|بلدها ايه|اصله منين|أصله منين|فين بلده|فين دولته)/.test(normalizedText)
    : /\bwhere\b[^?]*\b(from|made|come|comes)\b/i.test(normalizedText)
      || /\b(what|which)\s+countr(y|ies)\b[^?]*\bfrom\b/i.test(normalizedText)
      || /\bcountry of origin\b/i.test(normalizedText)
      || /\bmade in\b/i.test(normalizedText)
      || /\bfrom which countr/i.test(normalizedText);
  if (originItemRef && !namedCountry && asksOrigin) {
    return { intent: 'ecommerce_item_origin', item: originItemRef };
  }

  const serviceAreaAsked = matchesAny(normalizedText, patterns.service_area)
    || (verbGate && namedCountry && matchesAny(normalizedText, patterns.service_area_verb))
    || (verbGate && mentionsCountryTopic && matchesAny(normalizedText, patterns.service_area_verb));
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
    // Terse yes/no about a boolean status ("is it a best seller?", "is it
    // available?") — resolved on THIS product, answered "Yes/No", never the
    // hot-selling list or a raw "hot_selling: false" field dump. Checked first so
    // "is X hot selling?" about a named item doesn't fall through to the LIST.
    const statusYesNo = detectStatusYesNo(normalizedText, text, lang, itemInContext, categoryMatches.length > 0);
    if (statusYesNo) return statusYesNo;
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
    // Pronoun PRICE question ("سعرها كام", "طب سعره في حدود كام", "how much is
    // it") with NO product named this turn -> the price is about the item
    // already on the table. Bind it to that item instead of falling through to
    // a product-less quote or a stray fuzzy match on an unrelated product.
    // Gated on a context-pronoun so a fresh generic price ask ("بكام الشحن") is
    // NOT hijacked onto a stale item. Covers both languages so an English
    // follow-up resolves locally too, instead of only the Arabic phrasing.
    const CONTEXT_PRONOUN_RE = /(عنها|عنه|عنهم|منها|منه|ليها|لها|بتاعها|بتاعه|حقها|حقه|(?:سعر|تفاصيل|مواصفات|مميزات|لون|حجم|وزن|مقاس|بلد|صور)(?:ها|هم|هن|ه)(?![؀-ۿ])|\b(it|its|that one|this one)\b)/i;
    if (!foundItem && matchesAny(normalizedText, patterns.item_price) && CONTEXT_PRONOUN_RE.test(normalizedText)) {
      // Distinct intent name (rendered identically to item_price) so it is
      // recognized as ALWAYS-LOCAL and the AI classifier can't override it with
      // a wrong item ("سعره" -> generic "coffee" -> first coffee in catalog).
      return { intent: 'recall_item_price', item: itemInContext, quantity: extractQuantity(text) };
    }
  }

  // Stock-COUNT question ("فيه منه كام حبة", "how many in stock"). We hold no
  // per-item count (only availability), so naming a product can't produce a
  // number — answer that plainly instead of asking "which product?". A PRICE
  // word present ("بكام حبة") means it's a price/quote question, so let that fall
  // through to item_price below. "منه/it" resolves to the item in context.
  const pricePresent = /(بكام|بكم|سعر|اسعار|أسعار|بقديش|الثمن|حق|عرض سعر|price|cost|how much|quote)/i.test(normalizedText);
  if (!pricePresent && matchesAny(normalizedText, patterns.stock_quantity)) {
    return { intent: 'stock_quantity', item: itemInContext || foundItem || null };
  }

  // Minimum order quantity (MOQ) — a policy question, no product name needed.
  // Checked as a LOCAL, deterministic rule (never sent to the AI classifier)
  // so it can't get hijacked into an order-flow "which product?" prompt —
  // which is exactly what happened when this had no local rule at all and
  // fell through to the AI, which composed its own order-nudge instead of
  // answering the quantity question.
  if (matchesMoq(normalizedText)) {
    return { intent: 'moq', item: itemInContext || foundItem || null };
  }

  const asksPriceBase = matchesAny(normalizedText, patterns.item_price);
  // Quantity the customer stated ("بكم 100 حبة") — echoed back in price replies.
  const askedQuantity = extractQuantity(text);
  // "send me one product", "one fuckin product" — a hard cap to a SINGLE
  // result. Checked everywhere a list would otherwise be returned so a
  // quantity-limited ask never gets dumped the full matching set. A superlative
  // paired with a singular noun ("اكثر منتج مبيعا", "the best-selling product")
  // implies the same "just the #1 one" intent without needing "one"/"واحد" too.
  const wantsOne = matchesAny(normalizedText, patterns.single_item_request) || wantsSingleFromSuperlative(text);
  // Generalizes wantsOne to any explicit N ("3 منتجات بس") — composes with
  // country/category/hot-selling exactly like wantsOne already did for N=1.
  const requestedCount = extractRequestedProductCount(normalizedText) || (wantsOne ? 1 : null);

  // Country checking. A category named in the SAME message ("electronics in
  // saudi arabia") narrows the pool before the country filter runs, so the
  // two constraints combine instead of the category being silently dropped.
  // Detection can resolve to SEVERAL countries when a region is named ("دول
  // الخليج" -> every Gulf country stocked). Filtering matches ANY of them.
  // Pass RAW text (not normalizedText): 2-letter country codes ("SA", "UA") only
  // match when written UPPERCASE, and normalizedText is lowercased — so "in SA"
  // would silently fail to resolve Saudi Arabia. detectCountries normalizes
  // internally for its own substring checks.
  const detectedCountries = detectCountries(text, lang, items);
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

  // "Can you SEARCH for products in <country>?" is a CAPABILITY question
  // ("تقدروا تبحثوا؟", "do you search/source in X") — NOT a request to browse
  // the catalog. Dumping real matched items here is actively misleading: it
  // reads as "we physically stock this in Libya" when the honest answer is
  // "we CAN source from there" (sourcing business, no local inventory). The
  // owner already authored an exact FAQ for this per served country ("هل
  // يمكنكم البحث عن منتجات في ليبيا؟") — defer to it instead of the catalog
  // dump. Only intercepts when a FAQ actually matches; otherwise falls
  // through to the normal country-products listing unchanged.
  const CAPABILITY_ASK_RE = lang === 'ar'
    ? /(تقدر|يقدر|ممكن|يمكن|هل يمكن)[^؟?]{0,15}(تبحث|تدور|تلاق|توفر|تجيب|تحضر|تلقو|توفرو)/
    : /\b(can|could|do)\s+you\s+(search|find|source|get|look for|check)\b/i;
  if (activeCountries.length && CAPABILITY_ASK_RE.test(normalizedText)) {
    // Country-grounded lookup FIRST: a typo'd/colloquial capability question
    // ("تبحثه" vs the FAQ's "البحث", "لبيا" vs "ليبيا") can legitimately fail
    // matchFaq()'s generic word-overlap even though the country itself was
    // correctly resolved above — grounding on the country sidesteps that
    // entirely. Generic matchFaq is the fallback for a capability FAQ that
    // isn't written per-country.
    const countryFaqHit = findCountryCapabilityFaq({ business, lang, country: activeCountries[0], items });
    const faqHit = countryFaqHit || matchFaq({ text, lang, business });
    if (faqHit) {
      return { intent: 'faq', question: faqHit.question, answer: faqHit.answer };
    }
  }

  // "Can you PROVIDE/SOURCE <category>?" with NO country named ("هل يمكنكم
  // توفير منتجات تجميل؟") — a bare "yes we can source it" answer dodges the
  // customer: we may already STOCK that category. Resolve the category (literal
  // name first, then the alias table for words like تجميل -> الجمال والعناية)
  // and show its products WITH the capability line. Falls through untouched
  // when no category is recognizable — the generic capability answer stands.
  const PROVIDE_CAPABILITY_RE = lang === 'ar'
    ? /(يمكنكم|يمكنك|تقدروا|تقدرو|تقدرون|ممكن|هل يمكن|بتوفروا|بتوفرو|توفرون|عندكم امكاني[ةه])[^؟?]{0,25}(توفير|توفر|تجيب|تحضر|استيراد|تدبير)/
    : /\b(can|could|do)\s+you\s+(provide|supply|source|offer|get|import|find)\b/i;
  if (!activeCountries.length && PROVIDE_CAPABILITY_RE.test(normalizedText)) {
    const literalCategory = categoryMatches.length === 1 ? categoryMatches[0] : null;
    const resolved = literalCategory
      ? { display: literalCategory.display, items: literalCategory.items }
      : findCategoryByAlias(normalizedText, items, lang);
    if (resolved && resolved.items.length) {
      return { intent: 'ecommerce_capability_category', items: resolved.items, category: resolved.display };
    }
  }

  if (activeCountries.length) {
    const filterCountry = (i) => activeCountries.some((c) => countryMatchesItem(i, c));
    const categoryMatch = categoryMatches.length === 1 ? categoryMatches[0] : null;
    const basePool = categoryMatch ? categoryMatch.items : items;

    if (matchesHotSelling(normalizedText)) {
      const filtered = basePool.filter(isHotSelling).filter(filterCountry);
      if (requestedCount && filtered.length) {
        // Even a single #1 pick stays intent ecommerce_search_hot (a 1-item
        // list), NOT item_found: search_hot is in ALWAYS_LOCAL_INTENTS, while
        // item_found is deliberately AI-first — returning it here let the AI
        // classifier hijack "افضل منتج في السعودية" into a wrong-country miss.
        const capped = filtered.slice(0, requestedCount);
        return { intent: 'ecommerce_search_hot', items: capped, country: activeCountry, countries: activeCountries, category: categoryMatch?.display };
      }
      return { intent: 'ecommerce_search_hot', items: filtered, country: activeCountry, countries: activeCountries, category: categoryMatch?.display };
    }

    if (countryNamedThisTurn
      || matchesAny(normalizedText, patterns.ecommerce_country_products)
      || tokensCount(normalizedText) <= 3
      || categoryMatch
      || requestedCount) {
      const filtered = basePool.filter(filterCountry);
      if (requestedCount && filtered.length) {
        const capped = filtered.slice(0, requestedCount);
        if (capped.length === 1) {
          return { intent: 'item_found', item: capped[0], country: activeCountry, countries: activeCountries };
        }
        return { intent: 'ecommerce_country_products', items: capped, country: activeCountry, countries: activeCountries, category: categoryMatch?.display };
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

  // "give me N products" ("قلي 3 منتجات بس من اللي عندكم") with NO item,
  // category, or country named this turn — a plain sample-size request over
  // the whole catalog. No local rule covered this shape at all (it names no
  // item/category/"المنتجات"), so it used to fall through to the AI classifier,
  // which has no dedicated rule for it either and could land on a random
  // unrelated item's detail instead of a product list. Hot-sellers first (a
  // representative, honest sample), padded with the rest of the catalog.
  if (requestedCount && requestedCount > 1 && !foundItem && !categoryMatches.length) {
    // "افضل 3 منتجات" is a HOT-SELLING ask with an explicit count, not a
    // generic sample — keep the honest best-seller framing and cap the list.
    if (matchesHotSelling(normalizedText)) {
      return { intent: 'ecommerce_search_hot', items: items.filter(isHotSelling).slice(0, requestedCount) };
    }
    const hotFirst = [...items.filter(isHotSelling), ...items.filter((i) => !isHotSelling(i))];
    return { intent: 'ecommerce_sample_products', items: hotFirst.slice(0, requestedCount) };
  }

  // Hot / best selling (hot_selling boolean), optionally inside one category.
  // An explicit count — including the implicit 1 from a singular superlative
  // ("احسن منتج", "the best product") — caps the list. The intent stays
  // ecommerce_search_hot even for a single pick (see the country branch above:
  // item_found is AI-first and would let the classifier steal the query).
  if (matchesHotSelling(normalizedText)) {
    let hotItems = items.filter(isHotSelling);
    if (categoryMatches.length === 1) {
      hotItems = hotItems.filter(i => getDisplayCategory(i, lang) === categoryMatches[0].display);
    }
    if (requestedCount && hotItems.length) {
      hotItems = hotItems.slice(0, requestedCount);
    }
    return { intent: 'ecommerce_search_hot', items: hotItems, category: categoryMatches.length === 1 ? categoryMatches[0].display : undefined };
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
    if (categoryMatch.items.length === 1 || (requestedCount === 1)) {
      if (asksPriceBase) return { intent: 'item_price', item: categoryMatch.items[0], quantity: askedQuantity };
      return { intent: 'item_found', item: categoryMatch.items[0] };
    }
    if (requestedCount && requestedCount > 1) {
      return {
        intent: 'category_items',
        category: categoryMatch.display,
        items: categoryMatch.items.slice(0, requestedCount),
      };
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
  const priceEnabled = isPriceEnabled(business);
  const qtyEnabled = isQtyEnabled(business);
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
  // Shared by EVERY multi-item list reply (hot-selling, country products,
  // badges, ...) — whatever actually gets shown here becomes "the product(s)
  // on the table" for follow-ups. Previously only single-item cases
  // (item_found, etc.) updated last_item/last_shown_ids; a list reply left
  // them untouched, so "تفاصيل اكتر عنه" after a list resolved against
  // whatever item happened to be in context BEFORE this list — sometimes a
  // completely different, much older product. Set it here once so every
  // caller gets it for free instead of each case having to remember to.
  // totalCount lets a caller that pre-sliced its items (most do, ".slice(0,
  // 6)") tell us how many actually matched BEFORE the cut — so a "show me
  // everything" style request that matches far more than the display cap says
  // so explicitly instead of silently presenting a handful as if it were the
  // whole result, and points at both ways to see the rest.
  const applyItemList = (items, heading, totalCount) => {
    const itemLine = (item) => {
      const title = getDisplayTitle(item, locale);
      const desc = getDisplayDescription(item, locale);
      const priceText = !sourcing && item.price !== null && item.price !== undefined
        ? `\n${locale === 'ar' ? 'السعر' : 'Price'}: ${item.price} ${item.currency}`
        : '';
      return `**${title}**\n${desc}${priceText}`;
    };
    const truncated = Number.isFinite(totalCount) && totalCount > items.length;
    const truncationNote = truncated
      ? (locale === 'ar'
        ? `\n\nدي عينة من أصل ${totalCount} منتج — تواصل معنا أو تصفّح السوق لعرض الباقي.`
        : `\n\nThis is a sample of ${totalCount} matching products — contact us or browse the Marketplace to see the rest.`)
      : '';
    if (truncated) {
      addContactButton();
      addMarketplaceButton();
    }
    const thumbMsgs = buildThumbnailMessages(items, heading, itemLine);
    if (thumbMsgs) {
      payload.messages = thumbMsgs;
      payload.text = thumbMsgs.map((m) => m.text).filter(Boolean).join('\n\n') + truncationNote;
    } else {
      payload.text = [heading, ...items.map(itemLine)].join('\n\n') + truncationNote;
    }
    const shownIds = items.map((item) => item.id).filter((id) => Number.isFinite(id));
    if (shownIds.length) {
      payload.context_update.last_item = shownIds[0];
      payload.context_update.last_shown_ids = shownIds;
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
      addContactButton();
      // "lets discover the marketplace together" ... "so lets start" -> walk
      // them into guided discovery instead of dead-ending.
      payload.context_update.awaiting_discovery = true;
      break;

    // "give me N products" ("3 منتجات بس") — an explicit small sample from the
    // whole catalog, no other filter. Neutral heading (not "hot selling" —
    // padding items past the real hot-sellers would make that claim false).
    case 'ecommerce_sample_products': {
      // No truncation note here — the customer asked for exactly this many,
      // so showing exactly that many (already capped upstream) is correct,
      // not a cut-off; the "sample of N, contact us for more" framing would
      // be confusing when N is precisely what was requested.
      const heading = locale === 'ar' ? 'إليك بعض منتجاتنا:' : 'Here are some of our products:';
      applyItemList(intentResult.items, heading);
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      break;
    }

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

    case 'stock_quantity': {
      const item = intentResult.item;
      const name = item ? getDisplayTitle(item, locale) : '';
      payload.text = !qtyEnabled
        // Quantities OFF: hard cut — availability only, no invitation to state a qty.
        ? qtyDisabledText(locale, name)
        : (locale === 'ar'
          ? (name
            ? `لا نعرض عدد القطع المتوفرة من **${name}** بشكل محدد، لكنه متوفر ويمكننا توفير الكمية التي تحتاجها — تواصل معنا وأخبرنا بالكمية المطلوبة.`
            : `لا نعرض أعداد المخزون بشكل محدد، لكن يمكننا توفير الكمية التي تحتاجها — تواصل معنا وأخبرنا بالمنتج والكمية.`)
          : (name
            ? `We don't publish exact stock counts for **${name}**, but it's available and we can supply the quantity you need — contact us with your required quantity.`
            : `We don't publish exact stock counts, but we can supply the quantity you need — contact us with the product and quantity.`));
      if (item) {
        const thumb = getItemThumbnail(item);
        if (thumb) payload.thumbnail = thumb;
        payload.context_update.last_item = item.id;
      }
      addContactButton();
      payload.suggestions = suggestions.slice(0, 3);
      break;
    }

    case 'moq': {
      // Same "we don't disclose quantities in chat" cut as stock_quantity
      // when qty display is off — a minimum-order question is still a
      // quantity question, and per the owner's setting it gets the SAME
      // straight answer, never an invitation to name a product first.
      const item = intentResult.item;
      const name = item ? getDisplayTitle(item, locale) : '';
      payload.text = !qtyEnabled
        ? qtyDisabledText(locale, name)
        : (locale === 'ar'
          ? 'تختلف حدود الكمية للطلب (الحد الأدنى أو الأقصى) حسب نوع المنتج وسياسة المورد — تواصل معنا وسنؤكدها لك حسب المنتج الذي تحتاجه.'
          : 'Order quantity limits (minimum or maximum) vary by product and supplier policy — contact us and we\'ll confirm them for the product you need.');
      if (item) payload.context_update.last_item = item.id;
      addContactButton();
      payload.suggestions = suggestions.slice(0, 3);
      break;
    }

    case 'ecommerce_price_quote': {
      if (!priceEnabled) {
        // Prices OFF: cut the road immediately — no "which product?" fishing,
        // no quote invitation. This is the whole point of the toggle.
        payload.text = priceDisabledText(locale, '');
        addContactButton();
        payload.suggestions = suggestions.slice(0, 3);
        break;
      }
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

    case 'ecommerce_status_yesno': {
      const item = intentResult.item;
      const title = getDisplayTitle(item, locale);
      const yes = intentResult.statusValue;
      // Lead with the plain yes/no the customer asked for, then a short clause.
      const clause = {
        hot_selling: {
          ar: [`نعم ✅ — **${title}** من الأكثر مبيعاً لدينا.`, `لا — **${title}** ليس من الأكثر مبيعاً حالياً.`],
          en: [`Yes ✅ — **${title}** is one of our best-sellers.`, `No — **${title}** isn’t one of our best-sellers.`],
        },
        available: {
          ar: [`نعم ✅ — **${title}** متوفر.`, `لا — **${title}** غير متوفر حالياً، لكن يمكننا توفيره من شبكتنا.`],
          en: [`Yes ✅ — **${title}** is available.`, `No — **${title}** isn’t available right now, but we can source it from our network.`],
        },
        new: {
          ar: [`نعم ✅ — **${title}** من المنتجات الجديدة.`, `لا — **${title}** ليس ضمن الجديد.`],
          en: [`Yes ✅ — **${title}** is a new arrival.`, `No — **${title}** isn’t tagged as new.`],
        },
        trending: {
          ar: [`نعم ✅ — **${title}** من المنتجات الرائجة.`, `لا — **${title}** ليس ضمن الرائج.`],
          en: [`Yes ✅ — **${title}** is trending.`, `No — **${title}** isn’t trending.`],
        },
        limited: {
          ar: [`نعم ✅ — **${title}** كمية محدودة.`, `لا — **${title}** ليس ضمن الكمية المحدودة.`],
          en: [`Yes ✅ — **${title}** is a limited item.`, `No — **${title}** isn’t a limited item.`],
        },
      }[intentResult.statusKey];
      const pair = (clause && clause[locale]) || clause?.en || ['Yes', 'No'];
      payload.text = yes ? pair[0] : pair[1];
      const thumb = getItemThumbnail(item);
      if (thumb) payload.thumbnail = thumb;
      payload.suggestions = locale === 'ar' ? [`اطلب ${title}`, 'تفاصيل اكتر'] : [`Order ${title}`, 'More details'];
      payload.context_update.last_item = item.id;
      break;
    }

    case 'ecommerce_per_country': {
      const groups = Array.isArray(intentResult.groups) ? intentResult.groups : [];
      const subject = intentResult.subjectLabel;
      const heading = locale === 'ar'
        ? `${subject ? subject + ' — ' : ''}واحد من كل دولة متوفرة:`
        : `One ${subject || 'product'} from each available country:`;
      const lines = groups.map((g) => `- ${g.country}: ${getDisplayTitle(g.item, locale)}`);
      payload.text = [heading, ...lines].join('\n');
      payload.suggestions = groups.slice(0, 4).map((g) => getDisplayTitle(g.item, locale));
      payload.context_update.last_shown_ids = groups.map((g) => g.item.id).filter((id) => Number.isFinite(id));
      addMarketplaceButton();
      break;
    }

    case 'ecommerce_item_origin': {
      const item = intentResult.item;
      const title = getDisplayTitle(item, locale);
      const meta = item.metadata || {};
      const country = locale === 'ar'
        ? (meta.country_ar || meta.country_en || meta.country)
        : (meta.country_en || meta.country || meta.country_ar);
      payload.text = country
        ? (locale === 'ar' ? `**${title}** من ${country}.` : `**${title}** is from ${country}.`)
        : (locale === 'ar'
          ? `بلد المنشأ لـ **${title}** غير محدد حالياً — تواصل معنا ونؤكده لك.`
          : `The country of origin for **${title}** isn’t listed — contact us and we’ll confirm.`);
      const thumb = getItemThumbnail(item);
      if (thumb) payload.thumbnail = thumb;
      payload.suggestions = locale === 'ar' ? [`اطلب ${title}`, 'تفاصيل اكتر'] : [`Order ${title}`, 'More details'];
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
        applyItemList(intentResult.items.slice(0, 6), heading, intentResult.items.length);
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

    case 'ecommerce_capability_category': {
      // "Can you provide <category>?" — answer YES and prove it: the capability
      // line plus the actual products we already carry in that category.
      const heading = locale === 'ar'
        ? `نعم بالتأكيد — يمكننا توفير منتجات ${intentResult.category} من شبكة موردينا وبأفضل الأسعار. وهذه بعض المنتجات المتوفرة لدينا حالياً في هذا القسم:`
        : `Yes, absolutely — we can source ${intentResult.category} products through our supplier network at the best prices. Here are some of the products we currently carry in this category:`;
      applyItemList(intentResult.items.slice(0, 6), heading, intentResult.items.length);
      payload.suggestions = intentResult.items.slice(0, 3).map((item) => getDisplayTitle(item, locale));
      payload.context_update.last_category = intentResult.category;
      break;
    }

    case 'ecommerce_search_hot':
      if (intentResult.items && intentResult.items.length > 0) {
        const single = intentResult.items.length === 1;
        const headline = intentResult.country
          ? (locale === 'ar'
            ? (single ? `هذا هو المنتج الأكثر طلباً لدينا في ${intentResult.country}:` : `إليك المنتجات الأكثر طلباً في ${intentResult.country}:`)
            : (single ? `This is our top-selling product in ${intentResult.country}:` : `Here are the hot selling products in ${intentResult.country}:`))
          : (locale === 'ar'
            ? (single ? 'هذا هو المنتج الأكثر طلباً ومبيعاً لدينا:' : 'إليك المنتجات الأكثر طلباً ومبيعاً لدينا:')
            : (single ? 'This is our top-selling product:' : 'Here are our hot selling products:'));
        applyItemList(intentResult.items.slice(0, 6), headline, intentResult.items.length);
        payload.suggestions = intentResult.items.slice(0, 3).map(item => getDisplayTitle(item, locale));
      } else {
        // Name exactly which filters came up empty (category and/or country)
        // instead of a generic "no best-sellers" line — an empty result after
        // narrowing by category+country is a real, honest answer, not a
        // catch-all failure, and should read that way.
        payload.text = intentResult.category || intentResult.country
          ? (locale === 'ar'
            ? `لا يوجد حالياً منتجات أكثر مبيعاً ${intentResult.category ? `في قسم ${intentResult.category}` : ''}${intentResult.country ? ` من ${intentResult.country}` : ''}، لكن يمكنك تصفّح السوق لأحدث ما لدينا.`
            : `No hot-selling products right now${intentResult.category ? ` in ${intentResult.category}` : ''}${intentResult.country ? ` from ${intentResult.country}` : ''}, but you can browse the Marketplace for our latest products.`)
          : (locale === 'ar' ? 'لم نحدد منتجات كأكثر مبيعاً حالياً، لكن يمكنك تصفّح السوق لأحدث ما لدينا.' : 'No best-sellers are flagged right now, but you can browse the Marketplace for our latest products.');
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
        applyItemList(intentResult.items.slice(0, 6), heading, intentResult.items.length);
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
        const shownHere = intentResult.items.slice(0, 4);
        payload.text += '\n\n' + shownHere.map(i => `- ${getDisplayTitle(i, locale)}`).join('\n');
        payload.suggestions = shownHere.map(item => getDisplayTitle(item, locale));
        const shownIds = shownHere.map((item) => item.id).filter((id) => Number.isFinite(id));
        if (shownIds.length) {
          payload.context_update.last_item = shownIds[0];
          payload.context_update.last_shown_ids = shownIds;
        }
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

      // Price line — skipped entirely when price display is OFF (card shows the
      // ✅ availability above and nothing about price or a quote).
      if (!priceEnabled) {
        // no price/quote line at all
      } else if (sourcing) {
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
    case 'recall_item_price':
      // Pronoun price ("سعره كام") bound to the item already in context. Same
      // rendering as item_price — just a distinct intent so the router treats it
      // as always-local and the AI can't swap in the wrong product.
      return buildResponse({ ...intentResult, intent: 'item_price' }, lang, business);
    case 'item_price': {
      const item = intentResult.item;
      if (!priceEnabled) {
        // Prices OFF: this product IS available, but we don't quote here.
        payload.text = priceDisabledText(locale, getDisplayTitle(item, locale));
        addContactButton();
        const thumbP = getItemThumbnail(item);
        if (thumbP) payload.thumbnail = thumbP;
        payload.suggestions = locale === 'ar' ? [`اطلب ${getDisplayTitle(item, locale)}`] : [`Order ${getDisplayTitle(item, locale)}`];
        payload.context_update.last_item = item.id;
        break;
      }
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
        applyItemList(intentResult.items.slice(0, 6), heading, intentResult.items.length);
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
        applyItemList(intentResult.items.slice(0, 6), heading, intentResult.items.length);
        payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      } else {
        payload.text = locale === 'ar' ? 'وجدت مطابقات متعددة ولكن لم نتمكن من عرض التفاصيل.' : 'Multiple matches found but details could not be loaded.';
      }
      break;
    case 'brand_info': {
      const about = locale === 'ar'
        ? (business.about_ar || `نحن ${business.name_ar || business.name}. تواصل معنا إذا أردت معرفة المزيد.`)
        : (business.about_en || `We are ${business.name}. Contact us if you want to know more.`);
      // "What are your services?" deserves a concrete follow-through, not just the
      // corporate blurb — point them at the real categories they can browse/order.
      const cats = [...new Set(getBusinessItems(business.id).map((i) => getDisplayCategory(i, locale)).filter(Boolean))];
      if (cats.length) {
        const catLine = locale === 'ar'
          ? `\n\nونوفّر منتجات في أقسام متعددة منها: ${cats.slice(0, 8).join('، ')}. اسألني عن أي قسم أو منتج وأساعدك فوراً.`
          : `\n\nWe carry products across categories like: ${cats.slice(0, 8).join(', ')}. Ask me about any category or product and I'll help right away.`;
        payload.text = about + catLine;
        payload.suggestions = cats.slice(0, 4);
      } else {
        payload.text = about;
      }
      addMarketplaceButton();
      break;
    }
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
    case 'faq':
      // Owner-authored FAQ answer, matched directly by a rule (e.g. a
      // capability question like "can you search for products in Libya?").
      // Echoed verbatim — it's exact text the business wrote for this exact
      // question, not something to be paraphrased or padded.
      payload.text = intentResult.answer;
      payload.suggestions = suggestions.slice(0, 3);
      payload.context_update.last_faq = intentResult.question;
      break;
    case 'recall_topic': {
      const item = intentResult.item;
      if (item) {
        const title = getDisplayTitle(item, locale);
        payload.text = locale === 'ar'
          ? `كنا بنتكلم عن **${title}**. تحب تعرف تفاصيل أكتر عنه؟`
          : `We were talking about **${title}**. Want more details on it?`;
        const thumb = getItemThumbnail(item);
        if (thumb) payload.thumbnail = thumb;
        payload.suggestions = locale === 'ar' ? [`تفاصيل ${title}`, `اطلب ${title}`] : [`Details on ${title}`, `Order ${title}`];
        payload.context_update.last_item = item.id;
      } else {
        payload.text = locale === 'ar'
          ? 'ما اتكلمنا عن منتج محدد لسه. قولي على اللي يهمك وأنا هساعدك فوراً.'
          : "We haven't landed on a specific product yet. Tell me what you're after and I'll help right away.";
        payload.suggestions = suggestions.slice(0, 3);
      }
      break;
    }
    case 'language_meta': {
      // Answer IN the dialect they asked about — the answer itself is the proof.
      const byDialect = {
        gulf: 'ايه أكيد! أقدر أكلمك خليجي عادي 😄 — وش تبي تعرف عن منتجاتنا؟',
        egyptian: 'أكيد طبعاً! بتكلم مصري عادي 😄 — عايز تعرف ايه عن منتجاتنا؟',
        levantine: 'أكيد! بحكي معك شامي عادي 😄 — شو بدك تعرف عن منتجاتنا؟',
        english: "Of course! I can chat in English — what would you like to know about our products?",
      };
      payload.text = byDialect[intentResult.namedDialect]
        || (locale === 'ar'
          ? 'أكيد! بكلمك بأي لهجة تريحك — اسألني عن أي منتج وأنا معاك.'
          : "Of course! I'll match whatever language and dialect you're comfortable with — ask me anything about our products.");
      payload.suggestions = suggestions.slice(0, 3);
      break;
    }
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
  FEATURE_LABELS,
  contactButton,
  marketplaceButton,
  detectIntent,
  buildResponse,
  getWelcomeMessage(business, lang) {
    return lang === 'ar'
      ? (business.welcome_ar || `أهلاً بك في متجر ${business.name_ar || business.name}!`)
      : (business.welcome_en || `Welcome to ${business.name} store!`);
  },
  mapSheetRecords,
};
