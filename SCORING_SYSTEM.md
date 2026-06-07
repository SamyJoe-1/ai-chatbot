# AI Routing Scoring System
### Multi-Service Chatbot — Score-Based AI Gate

> **Purpose:** Define exactly how every incoming `prompt` gets scored before touching Ollama.  
> **Scope:** Covers all 5 service types: `cafe`, `restaurant`, `realestate`, `ecommerce`, `clinic`  
> **Fits into:** `index.js` → runs after auth check, before cache check, using `service_type` from request body

---

## 1. Where Scoring Lives in the Current Flow

Current flow in `index.js`:
```
POST /chat
  → auth check
  → cache check (getCache)
  → loadPrompt
  → build finalPrompt
  → Ollama
  → setCache
  → return response
```

New flow after adding scoring:
```
POST /chat
  → auth check
  → SCORE the prompt  ← NEW
  → score = 0? → return static response immediately (no cache, no Ollama)
  → score 1–3? → cache check → hit: return cached → miss: try rules → fail: Ollama
  → score 4+?  → cache check → hit: return cached → miss: straight to Ollama
```

**Why cache still runs on scored messages:**  
A complex message seen before (score 4+) already has a cached AI response. No reason to re-burn tokens on it.  
Cache skipped ONLY for score = 0 (pure static responses like greetings).

---

## 2. The 6 Scoring Signals

Every signal adds points to a final integer score. Signals are dirt cheap — regex + word list only. No NLP, no model calls.

---

### Signal 1 — Negation Detection `(+3 flat, immediate high-risk flag)`

The single most dangerous signal for rule-based failure. Any negation = rules will return wrong answer guaranteed.

**Why +3 flat:** Even one negation in a message means your positive-matching rules are useless. "Give me something without onions" will match onion-containing items. Flat +3 forces AI regardless of message complexity.

**Word lists — cover all 3 languages:**

| Language | Words |
|---|---|
| Arabic | `بدون`, `من غير`, `ما فيش`, `مش`, `بدونه`, `بدونها`, `لا يحتوي`, `خالي من`, `ما يكونش`, `ممنوع`, `بدون إضافة` |
| English | `without`, `no `, `not`, `except`, `exclude`, `free from`, `don't want`, `remove`, `minus`, `allergic` |
| Franco | `bdoun`, `mn ghir`, `msh`, `ma fish`, `bala`, `wala`, `mesh` |

**Edge case:** `"no problem"`, `"no worries"` → these are false positives. Maintain a **negation exceptions list** — phrases where negation is social/filler not food/request related. Check full bigram before scoring.

---

### Signal 2 — Pipeline Count `(+1 per additional pipeline beyond the first)`

You already have pipeline identifiers per service (order, welcome, menu_query, complaint, booking, etc.). Run a scan against ALL pipeline keyword sets and count how many distinct pipelines the message hits.

- 1 pipeline hit → +0 (normal, expected)
- 2 pipeline hits → +1
- 3 pipeline hits → +2
- 4+ pipeline hits → +3 (cap here)

**Example:**
```
"hi i want to order a margherita without olives"
→ welcome pipeline   (+0, first hit)
→ order pipeline     (+1)
→ menu_query pipeline (+1)
→ negation signal    (+3)
= total: 5 → straight to Ollama
```

**Why this matters:** Each pipeline you hit alone is fine. Compound messages that span pipelines are exactly where rule-based systems break because they can only execute one path at a time.

---

### Signal 3 — Recommendation / Comparison Request `(+2)`

These require reasoning over `source_data`, not lookup. Rules can never handle them.

| Language | Trigger Words |
|---|---|
| Arabic | `انصحني`, `ايه الأحسن`, `أحسن حاجة`, `أفضل`, `الأرخص`, `الأغلى`, `الأكتر`, `فرق بين`, `مقارنة`, `زي بعض` |
| English | `recommend`, `best`, `better`, `cheapest`, `most popular`, `difference between`, `compare`, `which is`, `suggest`, `what's good` |
| Franco | `ana7ni`, `e7 el a7san`, `meen a7san`, `farq`, `zay ba3d` |

---

### Signal 4 — Modifier / Condition Chain `(+1 per occurrence, max +3)`

Each conjunction that modifies a previous intent adds complexity. Count them.

| Language | Words |
|---|---|
| Arabic | `وكمان`, `بس`, `وبدل`, `لكن`, `وبدون`, `وعايز`, `كمان`, `وأيضاً` |
| English | `but`, `and also`, `with extra`, `instead of`, `as well`, `plus`, `add`, `extra` |
| Franco | `bas`, `w kaman`, `w bdoun`, `w 3ayez`, `zeyada` |

**Example:**
```
"i want a large pizza with extra cheese but no olives and add mushrooms"
→ modifier: "with extra" (+1)
→ modifier: "but"        (+1)  
→ modifier: "and add"    (+1)
→ negation: "no"         (+3)
= 6 → Ollama
```

---

### Signal 5 — Unknown Token Ratio `(+1 if ratio > 40%, +2 if ratio > 65%)`

Against your keyword dictionary for the active `service_type`. Stopwords excluded before counting.

**Why:** If most of the message doesn't match your known vocabulary, your rules literally have nothing to work with. Better to forward to Ollama than return a confident wrong answer.

**How to calculate:**
```
meaningful_tokens = tokens filtered against stopword list
unknown_count = tokens not found in service_type keyword dictionary
ratio = unknown_count / meaningful_tokens

ratio > 0.40 → +1
ratio > 0.65 → +2
```

**Important:** Maintain separate keyword dictionaries per `service_type`. A word like `listing` is known in `realestate` but unknown in `cafe`.

---

### Signal 6 — Question Type: Open vs Closed `(+0 closed, +2 open)`

**Closed question** = has exactly one factual answer that lives directly in `source_data`. Rules or a lookup can answer it.  
**Open question** = requires reasoning, synthesis, or inference over `source_data`.

**Closed triggers (rules handle):**
- "what's the price of X"
- "do you have X"
- "what's the address"
- "are you open now"
- "what sizes do you have"

**Open triggers (+2):**

| Language | Trigger Words |
|---|---|
| Arabic | `ايه رأيك`, `تنصحني`, `ليه`, `ازاي`, `فرق إيه`, `مناسب لـ`, `مناسب لمين`, `حلو ليه` |
| English | `why`, `how come`, `what would you`, `what should i`, `is it worth`, `suitable for`, `good for`, `tell me about` |
| Franco | `leh`, `3shan eh`, `mناسب`, `yesta7el` |

---

## 3. Score Thresholds

```
Score 0      → Static response — no cache, no Ollama
Score 1–3    → Rules-first zone — cache check → rules → Ollama fallback  
Score 4+     → AI zone — cache check → Ollama directly
```

**What "rules-first zone" means in practice:**  
Your existing pipeline logic runs. If it returns a confident match with an actual item/answer from `source_data` → return it. If it returns null or low confidence → escalate to Ollama. The score doesn't replace your pipeline logic, it acts as the gate that decides whether to even try rules or skip straight to AI.

---

## 4. Per-Service-Type Configuration

Each service type has different baseline complexity. Same signals apply but thresholds shift.

---

### 4.1 `cafe` and `restaurant`

**Characteristics:**  
Most messages are simple and closed. Menu items are concrete. Orders follow predictable patterns. Highest volume, cheapest to handle.

**Threshold:** Standard (0 / 1–3 / 4+)

**Known pipelines:**
- `welcome` — greetings, hello, hi, أهلاً, مرحبا
- `menu_query` — what do you have, show menu, category items, price of X
- `order` — i want, order, عايز, طلب
- `complaint` — wrong order, cold food, late delivery
- `info` — address, hours, wifi, table booking

**Examples — score breakdown:**

| Message | Signals | Score | Route |
|---|---|---|---|
| `"hi"` | none | 0 | Static |
| `"do you have pepperoni pizza"` | menu_query only | 1 | Rules |
| `"i want a large pizza"` | order only | 1 | Rules |
| `"what drinks do you have"` | menu_query only | 1 | Rules |
| `"i want pizza and what's the wifi password"` | order + info (pipeline +1), modifier (+1) | 2 | Rules → fallback |
| `"recommend something for someone who doesn't eat meat"` | recommendation (+2), negation (+3) | 5 | Ollama |
| `"large pizza no olives extra cheese but add jalapeños"` | negation (+3), modifier x2 (+2) | 5 | Ollama |
| `"what's the difference between the two pasta dishes"` | comparison (+2), open question (+2) | 4 | Ollama |

**Static responses (score 0) — full list:**
- All greeting variants: hi, hello, hey, مرحبا, أهلاً, هاي, السلام عليكم, صباح الخير, مساء الخير
- Positive acknowledgements: ok, okay, sure, تمام, ماشي, أوكي
- Thank you variants: thanks, thank you, شكراً, تسلم
- Goodbye variants: bye, goodbye, مع السلامة, باي

---

### 4.2 `realestate`

**Characteristics:**  
Almost nothing is simple here. Properties have dozens of attributes. Customers ask comparative, conditional, and contextual questions constantly. Lowest volume but highest complexity per message.

**Threshold shift:** Lower AI trigger to score 3+ (not 4+). The extra caution is worth it — a wrong property suggestion is far more damaging than one extra Ollama call.

**Known pipelines:**
- `welcome` — greetings
- `search` — looking for, i need, عايز شقة, find me
- `details` — tell me about, what's included, مساحة, details of X
- `compare` — difference between, which is better, فرق بين
- `contact` — speak to agent, call me, اتصل بي, visit
- `pricing` — price, installment, تقسيط, down payment, عربون
- `availability` — available, free, متاح, when can I see it

**Real estate specific signals — add these on top of base signals:**

| Signal | Words | Score |
|---|---|---|
| Financial conditions | `installment`, `down payment`, `تقسيط`, `مقدم`, `قسط` | +1 |
| Location preference | `near`, `close to`, `قريب من`, `جنب`, `ناحية` | +1 |
| Spec conditions | `at least`, `minimum`, `not less than`, `مش أقل`, `على الأقل` | +2 |
| Timeline | `by`, `before`, `within`, `خلال`, `قبل` | +1 |

**Examples — score breakdown:**

| Message | Signals | Score | Route |
|---|---|---|---|
| `"hi"` | none | 0 | Static |
| `"do you have 2-bedroom apartments"` | search only | 1 | Rules |
| `"price of unit 4B"` | pricing only | 1 | Rules |
| `"i need a 3-bedroom near a school under 1M"` | search + location (+1) + spec condition (+2) | 3 | Ollama (threshold 3+) |
| `"what's better, unit 4B or 7C"` | comparison (+2), open question (+2) | 4 | Ollama |
| `"i need something with at least 150sqm close to a metro not more than 2M with installment"` | spec (+2), location (+1), negation (+3), financial (+1) | 7 | Ollama |

**Static responses (score 0):**
- Greetings only. Everything else in real estate should go through rules at minimum.

---

### 4.3 `ecommerce`

**Characteristics:**  
Sits between café and real estate in complexity. Products have variants (size, color, model). Orders and returns are structured but filtering queries can get complex. Medium volume.

**Threshold:** Standard (0 / 1–3 / 4+)

**Known pipelines:**
- `welcome` — greetings
- `product_search` — looking for, do you have, عايز, بدور على
- `order` — i want to order, buy, شراء, order
- `track` — where is my order, track, تتبع, status
- `return` — return, exchange, استرجاع, استبدال
- `discount` — promo code, offer, discount, خصم, كود
- `product_details` — specs, description, details, مواصفات

**E-commerce specific signals:**

| Signal | Words | Score |
|---|---|---|
| Variant chaining | `in color`, `size`, `model`, `بلون`, `مقاس`, `موديل` | +1 |
| Availability + variant | `available in` + any variant | +1 |
| Multi-product | `and`, `also` between two product names | +1 |
| Return conditions | `if`, `in case`, `لو`, `في حالة` + return word | +2 |

**Examples — score breakdown:**

| Message | Signals | Score | Route |
|---|---|---|---|
| `"hi"` | none | 0 | Static |
| `"do you have this shirt in blue"` | product_search + variant (+1) | 2 | Rules |
| `"i want to order the black jacket size L"` | order + variant (+1) | 2 | Rules |
| `"what's your return policy if the item is damaged"` | return + condition (+2) | 3 | Rules → fallback |
| `"i need a laptop under 15k that's good for gaming but not too heavy"` | search + spec (+2) + open (+2) + negation (+3) | 7 | Ollama |
| `"recommend something similar to X but cheaper and available now"` | recommendation (+2) + negation (+3) + comparison (+2) | 7 | Ollama |

---

### 4.4 `clinic`

**Characteristics:**  
Treat like real estate — lower threshold, higher caution. Medical context means a wrong answer isn't just bad UX, it's a liability. Most questions are open. Even "simple" questions like "is this medicine safe for kids" require reasoning.

**Threshold shift:** AI trigger at score 2+ (not 4+). Anything beyond a pure greeting or basic info query goes to Ollama.

**Known pipelines:**
- `welcome` — greetings
- `booking` — book appointment, حجز, موعد, schedule
- `doctor_info` — who is, specialist, دكتور, available doctor
- `service_info` — what do you treat, services, تخصص
- `pricing` — price, cost, كام, how much
- `location_hours` — address, hours, open, فين, امتى
- `symptom_query` — i have, symptoms, ألم, عندي

**Clinic specific signals — extremely sensitive:**

| Signal | Words | Score |
|---|---|---|
| Any symptom mention | `pain`, `ألم`, `عندي`, `i have`, `i feel`, `حاسس`, `بوجعني` | +3 |
| Medication mention | `medicine`, `drug`, `دواء`, `حبة`, `جرعة`, `dose` | +3 |
| Child/elderly mention | `child`, `kid`, `baby`, `طفل`, `كبير في السن`, `elderly` | +2 |
| Urgency | `emergency`, `urgent`, `طارئ`, `بسرعة`, `فوراً` | +2 |
| Condition/diagnosis | `diabetes`, `pressure`, `سكر`, `ضغط`, any disease name | +3 |

**Why +3 on symptoms and medication:** These are the exact cases where a wrong rule-based answer is dangerous. Force Ollama every time without exception.

**Examples — score breakdown:**

| Message | Signals | Score | Route |
|---|---|---|---|
| `"hi"` | none | 0 | Static |
| `"what are your working hours"` | location_hours only | 1 | Rules |
| `"i want to book an appointment"` | booking only | 1 | Rules |
| `"how much does a checkup cost"` | pricing only | 1 | Rules |
| `"i have chest pain since yesterday"` | symptom (+3) | 3 | Ollama (threshold 2+) |
| `"is ibuprofen safe for a 5-year-old"` | medication (+3) + child (+2) | 5 | Ollama |
| `"my mom has diabetes and i need to book her an appointment fast"` | condition (+3) + urgency (+2) + booking | 5 | Ollama |
| `"i feel dizzy and my blood pressure is high, what should i do"` | symptom (+3) + condition (+3) + open question (+2) | 8 | Ollama |

**Static responses (score 0):**
- Greetings ONLY. Not even "are you open" should be static in a clinic — return it from rules using actual `source_data` hours.

---

## 5. Keyword Dictionaries Structure

Each `service_type` needs its own keyword dictionary. Structure it as a flat object keyed by pipeline name. The scoring engine iterates all pipelines, counts hits.

```
dictionaries/
  cafe.json
  restaurant.json
  realestate.json
  ecommerce.json
  clinic.json
```

Each file follows this shape:
```json
{
  "welcome":       ["hi", "hello", "hey", "مرحبا", "أهلاً", "hala", "hii"],
  "order":         ["order", "want", "عايز", "طلب", "i need", "give me", "اطلب"],
  "menu_query":    ["menu", "have", "provide", "category", "list", "عندكم", "فيه"],
  "negation":      ["without", "no ", "not", "بدون", "من غير", "مش", "bdoun"],
  "recommendation":["recommend", "best", "انصحني", "أحسن", "a7san"],
  "modifier":      ["but", "also", "extra", "بس", "وكمان", "زيادة"],
  "stopwords":     ["the", "a", "an", "i", "me", "my", "is", "are", "في", "من", "على", "و"]
}
```

**Important rules for dictionary maintenance:**
- Negation and modifier lists are **shared across all service types** — they're language signals not domain signals
- Recommendation and comparison lists are also shared
- Domain-specific pipelines (symptom, booking, product_search, etc.) are per service type
- Add Franco variants for every Arabic word — they will come in at high traffic
- Keep stopwords per language in the same file so unknown token ratio calculation is accurate

---

## 6. Static Response Registry

Score = 0 messages never touch the DB or Ollama. They return immediately from a hardcoded map.

Structure:
```json
{
  "greetings": {
    "patterns": ["hi", "hello", "hey", "مرحبا", "أهلاً", "هاي", "السلام عليكم", "صباح الخير", "مساء الخير", "hala", "hii", "salam", "alo"],
    "response": "service_type_greeting"
  },
  "acknowledgement": {
    "patterns": ["ok", "okay", "sure", "تمام", "ماشي", "أوكي", "ok تمام", "oki"],
    "response": "acknowledged"
  },
  "thanks": {
    "patterns": ["thanks", "thank you", "شكراً", "شكرا", "تسلم", "thx", "ty"],
    "response": "youre_welcome"
  },
  "goodbye": {
    "patterns": ["bye", "goodbye", "مع السلامة", "باي", "yalla bye", "tc"],
    "response": "goodbye"
  }
}
```

Each `service_type` can override the response text — a clinic says something different on greeting than a café — but the pattern detection is shared.

**Matching logic for static:** Exact match after `normalize()` (same function already in `cache.js`). No fuzzy matching here — these are short enough that exact normalized match covers all variants through the dictionary.

---

## 7. The `scoreMessage` Function — Full Spec

**Input:**
```js
scoreMessage(prompt, serviceType)
```

**Output:**
```js
{
  score: Number,          // raw integer score
  signals: String[],      // list of what triggered (for logging/debug)
  route: 'static' | 'rules' | 'ai',
  static_key: String | null  // set only when route = 'static'
}
```

**Internal steps:**
1. `normalize(prompt)` — same function from `cache.js`
2. Check static registry → if match → return `{ score: 0, route: 'static', static_key: ... }`
3. Load dictionary for `serviceType`
4. Run Signal 1 (negation) — scan negation word list
5. Run Signal 2 (pipeline count) — scan all pipeline keyword lists, count distinct hits
6. Run Signal 3 (recommendation) — scan recommendation word list
7. Run Signal 4 (modifier chain) — count modifier words
8. Run Signal 5 (unknown token ratio) — tokenize, remove stopwords, check against full dictionary
9. Run Signal 6 (question type) — scan open question triggers
10. Apply service-type threshold rules → set `route`
11. Return result object

**Performance note:** Steps 4–9 are all string scans on a short message against small word lists. Total execution time per message should be under 1ms. Do not async this — run it synchronously before any I/O.

---

## 8. Integration Points in `index.js`

Three changes to the existing file, nothing else:

**Change 1 — After auth check, before cache:**
```js
const scored = scoreMessage(prompt, service_type);

if (scored.route === 'static') {
  return res.json({ 
    response: getStaticResponse(scored.static_key, service_type),
    from_cache: false,
    scored: true,
    route: 'static'
  });
}
```

**Change 2 — Cache check stays exactly where it is.** No changes needed. Cache runs for both `rules` and `ai` routes.

**Change 3 — Pass score context to your pipeline logic (rules zone):**
```js
if (scored.route === 'rules') {
  const ruleResult = tryRules(prompt, service_type, source_data);
  if (ruleResult) {
    return res.json({ response: ruleResult, from_cache: false, route: 'rules' });
  }
  // fallthrough to Ollama
}
// score = ai OR rules fallthrough → continue to Ollama as normal
```

**What does NOT change:**
- `getCache` / `setCache` calls — untouched
- `loadPrompt` — untouched  
- `finalPrompt` building — untouched
- Ollama axios call — untouched
- Stream handling — untouched

---

## 9. Threshold Summary Table

| Service Type | Static (score) | Rules Zone | AI Zone |
|---|---|---|---|
| `cafe` | 0 | 1–3 | 4+ |
| `restaurant` | 0 | 1–3 | 4+ |
| `realestate` | 0 | 1–2 | 3+ |
| `ecommerce` | 0 | 1–3 | 4+ |
| `clinic` | 0 | 1 | 2+ |

---

## 10. Edge Cases to Handle

**1. Empty or whitespace-only prompt**  
Score 0, return error or a "didn't catch that" static response. Don't send to Ollama.

**2. Pure emoji messages**  
`"🍕"` — all tokens unknown, high unknown ratio → BUT the message is 1 token. Cap minimum token count at 3 before unknown ratio fires. Below 3 meaningful tokens → fallback to rules with the raw token as keyword search.

**3. Repeated messages from same user**  
Cache handles this already. Scoring runs first but cache will return immediately on the second hit.

**4. Very long messages (100+ words)**  
Add a signal: message word count > 50 → +1. These are descriptions, complaints, or multi-request blocks. Always complex.

**5. Code-switching mid-sentence**  
`"ana 3ayez pizza بدون بصل"` — your dictionary needs Franco entries. The normalization already lowercases, so Franco matching works as long as the dictionary has the variant. This is the #1 gap to fill in your word lists.

**6. Negation false positives**  
`"no problem"`, `"not bad"`, `"no worries"` — maintain a bigram exceptions list. Check full 2-word phrase before scoring the negation.

```js
const NEGATION_EXCEPTIONS = [
  'no problem', 'no worries', 'not bad', 'no way', 
  'مش مشكلة', 'مش تمام', 'لا شكر على واجب'
];
// Check: if any exception phrase exists in normalized prompt, skip negation signal
```

---

## 11. Files to Create

```
project/
  scoring/
    scoreMessage.js       ← main scoring function
    staticResponses.js    ← static response registry + getter
    thresholds.js         ← per-service-type threshold config
  dictionaries/
    cafe.json
    restaurant.json
    realestate.json
    ecommerce.json
    clinic.json
    shared.json           ← negation, modifier, recommendation, stopwords (all services)
```

`index.js` imports only `scoreMessage` and `getStaticResponse`. Everything else is internal to the scoring module.

---

## 12. What This Does NOT Cover

- **Sentiment / tone detection** — not needed for routing, adds cost for no benefit
- **Language detection** — your dictionaries cover all 3 languages, no need to detect first
- **Fuzzy matching in scoring** — scoring is a gate, not a resolver. Keep it exact + regex only
- **Session/conversation context** — scoring operates on the single message only. If you later add session context (user said X two messages ago), that's a separate layer on top, not part of scoring
- **Confidence scoring for rule results** — that's inside your pipeline logic, not the scoring gate
