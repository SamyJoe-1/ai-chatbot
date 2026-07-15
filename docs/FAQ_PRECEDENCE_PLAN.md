# FAQ Precedence Fix Plan

> **STATUS: IMPLEMENTED (2026-07-15).** Phase 1 fully (pre-AI strong-FAQ gate,
> FAQ-over-[11], structural filler check, `[10] faq lookup` wired into both
> prompts with `faq_topics` in the classify schema), Phase 2's coverage scoring
> + cross-language fallback, and Phase 3's shadow telemetry + golden tests
> (`scripts/test-faq-precedence.js`, 18/18 passing). E2E-verified: the Sourcing
> question now answers from the owner FAQ with ZERO AI tokens. Remaining
> optional: Phase 2's offline alias expansion at FAQ-save time.
> **Restart both servers to load the changes.**

## The miss, reproduced

Customer: `كيف تتم عملية الـ Sourcing؟`
Bot: `أنا هنا لمساعدتك! كيف أقدر أساعدك في عملية الـ Sourcing؟` (a content-free bounce)

The FAQ exists **word-for-word** in `businesses.faq_ar` (business 3, E-Global Trading), and the
matcher finds it perfectly:

```
matchFaq({ text: 'كيف تتم عملية الـ Sourcing؟', lang: 'ar', business })
→ { question: 'كيف تتم عملية الـ Sourcing؟', answer: 'نستقبل تفاصيل طلبك…', overlap: 5 }
```

**The matcher is not the problem. Search is not the problem. A vector DB would not have
fixed this.** The message never reached `matchFaq` at all.

## Root cause chain (verified, not guessed)

1. **FAQ is a last-resort check.** `applyFaqFallback` (`src/routes/api/message.js:691`) only
   runs when the final intent is in `NOT_FOUND_INTENTS`. Any pipeline that "handles" the
   message — including an AI `[11]` one-liner — bypasses a perfect FAQ hit.
2. **The AI classifier fired first and bounced.** `ai_calls` row 481: mode `classify`,
   1,756 tokens, output `[11] أنا هنا لمساعدتك! بس قولي أي منتج حاب تبحث عنه…`.
   `[11] handled=true` → returned to the customer → FAQ never consulted.
3. **The filler guard is a regex blocklist and missed this phrasing.** `isFillerAiReply`
   (`message.js:297`) covers "what do you need / ايه اللي محتاجه" shapes but not
   "أنا هنا لمساعدتك! …". Worse, the prompt **teaches** the model this exact filler:
   `aria_agent/rules/ecommerce.txt:62-64` few-shots reply `أنا هنا لمساعدتك! / أنا معاك!`.
4. **The classifier has no FAQ route.** `message.js:593` handles `pipeline.code === 10`
   (FAQ) — but neither `rules/ecommerce.txt` nor `rules/cafe.txt` lists a `[10]` pipeline.
   That handler is dead code: the classifier literally cannot say "this is an FAQ".
5. **Cost insult:** 1,756 tokens were burned on a question answerable locally for 0.

## Phase 1 — Precedence (the actual fix, ~1 day)

### 1a. FAQ pre-gate before the AI call
In `message.js`, just before the threshold AI gate (`~line 1097`, next to the existing
`localFirstProbe`), run `matchFaq`. A **strong** hit answers immediately, zero tokens:

- strong = `overlap >= 3`, **or** `overlap >= 2` with a distinctive keyword **and**
  coverage `>= 0.6` (matched keywords ÷ message keywords).
- Placement matters: it sits *after* the early-order-intent block (`line 1066`), so
  "order X" still wins over an FAQ that shares words — preserves the order-vs-inquiry
  rule. Weak hits (overlap 2, low coverage) stay where they are today, as the
  not-found fallback.

### 1b. Owner FAQ outranks AI `[11]`
Inside the `pipeline.code === 11` handler (`message.js:614`): before accepting the AI's
one-liner, call `resolveFaqWithContext()`. If it hits, serve the FAQ. An owner-authored
answer always beats an AI guess. (With 1a in place this is a belt-and-suspenders guard for
messages that reach AI via the rules_fallback path at `line 1296`.)

### 1c. Fix the filler guard properly
- Add the Arabic bounce family to `AI_FILLER_RE`: `أنا هنا لمساعدتك`, `أنا معاك`,
  `كيف أقدر أساعدك`, `وش تبي تعرف`, `قولي أي منتج`.
- Add a structural check: a reply that contains **no content words from outside the
  customer's own message** and ends with a question back is filler regardless of phrasing.
  Regex blocklists lose this arms race; the structural check doesn't.
- Fix the prompt side too: in `rules/ecommerce.txt` / `cafe.txt`, keep the "I'm here to
  help" few-shots only for messages that genuinely carry no question, and add a rule:
  *"If the message asks HOW/WHAT/WHEN about the store's services or policies and you
  don't know the answer, output `[10]` — never a re-ask."*

### 1d. Wire up the dead `[10]` pipeline
Add `[10] FAQ / store policy question` to both prompt files, and include the FAQ
**question titles only** (not answers) in the classify prompt — ~35 questions ≈ 150–300
tokens, sits in the cached prefix so marginal cost is near zero. The `code === 10` handler
in `message.js:593` already resolves it locally via `resolveFaqWithContext()`.

## Phase 2 — Recall without a vector DB

Verdict on vector DB: **no.** 20–40 FAQs per brand is not a retrieval problem; it's a
synonym problem. A vector service adds a dependency, per-message embedding latency/cost,
and a second thing to babysit — to search a list that fits in one screen.

Instead, reuse the pattern that already works here (brand concept map):

- **Offline FAQ expansion:** when an FAQ is saved/imported, one cached AI call generates
  aliases per question — MSA + Egyptian/Gulf/Levantine variants, Franco-Arabic, and the
  English term (سورسنج / sourcing / توريد / تدبير). Store alongside the FAQ. Runtime
  matching stays the same keyword overlap, now over `question + aliases`. 0 tokens/message.
- **Coverage scoring:** replace the raw `overlap >= FAQ_MIN_OVERLAP` accept with
  `score = overlap/messageKeywords` weighted by distinctive hits. Fixes both directions:
  long messages stop matching FAQs on 2 incidental words, short exact questions match
  confidently.
- **Cross-list fallback:** an `ar` message currently searches only `faq_ar`
  (`faqMatcher.js:95`). If the owner authored the entry only in English (common for
  loanword topics like "Sourcing"), it's invisible. Search the same-language list first,
  the other list as fallback.

## Phase 3 — Never miss silently again

- **Telemetry:** whenever a classify call is spent, also run the strong-FAQ check and log
  `faq_shadow_hit=true` when it would have answered. That row = money burned + owner
  content ignored. Review weekly; it also auto-validates Phase 1.
- **Golden tests:** a fixture of real customer phrasings → expected FAQ id, run in CI
  (include this Sourcing case, the Libya capability case, and the dialect variants).

## Expected outcome

- This class of miss → zero: an exact-match FAQ can no longer be stolen by an AI bounce.
- Token spend **drops** (FAQ asks skip the 1.7k-token classify call entirely).
- Stays inside the existing budget philosophy: rules first, AI only when rules can't.
