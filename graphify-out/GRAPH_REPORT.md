# Graph Report - .  (2026-06-09)

## Corpus Check
- 61 files · ~65,545 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 821 nodes · 1459 edges · 37 communities (36 shown, 1 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.79)
- Token cost: 74,553 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Brain Intent Matching & Query Recovery|Brain Intent Matching & Query Recovery]]
- [[_COMMUNITY_Order Flow State Machine|Order Flow State Machine]]
- [[_COMMUNITY_Portal Admin SPA|Portal Admin SPA]]
- [[_COMMUNITY_AI Routing & Gating|AI Routing & Gating]]
- [[_COMMUNITY_Project Docs & Concepts|Project Docs & Concepts]]
- [[_COMMUNITY_E-Commerce Brain & AI Pipelines|E-Commerce Brain & AI Pipelines]]
- [[_COMMUNITY_Chat Widget UI|Chat Widget UI]]
- [[_COMMUNITY_Dashboard SPA Core|Dashboard SPA Core]]
- [[_COMMUNITY_Message API Pipeline|Message API Pipeline]]
- [[_COMMUNITY_Dashboard Sessions & Orders UI|Dashboard Sessions & Orders UI]]
- [[_COMMUNITY_Real Estate Brain|Real Estate Brain]]
- [[_COMMUNITY_Real Estate Sample Profile|Real Estate Sample Profile]]
- [[_COMMUNITY_NPM Package & Dependencies|NPM Package & Dependencies]]
- [[_COMMUNITY_Business Admin API|Business Admin API]]
- [[_COMMUNITY_Cafe Sample Profile|Cafe Sample Profile]]
- [[_COMMUNITY_Session Init API|Session Init API]]
- [[_COMMUNITY_Cafe Admin API|Cafe Admin API]]
- [[_COMMUNITY_Catalog Store & Cache|Catalog Store & Cache]]
- [[_COMMUNITY_SQLite Database Layer|SQLite Database Layer]]
- [[_COMMUNITY_Google Sheets Sync|Google Sheets Sync]]
- [[_COMMUNITY_Portal API Routes|Portal API Routes]]
- [[_COMMUNITY_Auth & JWT Middleware|Auth & JWT Middleware]]
- [[_COMMUNITY_AI Rate Limiter|AI Rate Limiter]]
- [[_COMMUNITY_FAQ Matcher|FAQ Matcher]]
- [[_COMMUNITY_Response Patterns & Responder|Response Patterns & Responder]]
- [[_COMMUNITY_Catalog Sync API|Catalog Sync API]]
- [[_COMMUNITY_Session Lifecycle|Session Lifecycle]]
- [[_COMMUNITY_Menu Admin API|Menu Admin API]]
- [[_COMMUNITY_Express Server Bootstrap|Express Server Bootstrap]]
- [[_COMMUNITY_Search API & Token Validation|Search API & Token Validation]]
- [[_COMMUNITY_Franco-Arabic Transliteration|Franco-Arabic Transliteration]]
- [[_COMMUNITY_Brain Registry|Brain Registry]]
- [[_COMMUNITY_Database Admin Route|Database Admin Route]]
- [[_COMMUNITY_Phone Validation|Phone Validation]]
- [[_COMMUNITY_Arabic-English Translation|Arabic-English Translation]]
- [[_COMMUNITY_Sample Menu Build Script|Sample Menu Build Script]]
- [[_COMMUNITY_Claude Settings|Claude Settings]]

## God Nodes (most connected - your core abstractions)
1. `normalize()` - 36 edges
2. `tokenize()` - 28 edges
3. `handleOrderMessage()` - 25 edges
4. `getBusinessItems()` - 23 edges
5. `selectCafe()` - 13 edges
6. `sendMessage()` - 13 edges
7. `findScoredItems()` - 12 edges
8. `resolveAiPipeline()` - 12 edges
9. `assessAiRoutingNeed()` - 11 edges
10. `readRecordsFromSheet()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `API JSON Catalog Sync` --semantically_similar_to--> `Google Sheets Synchronization Flow`  [INFERRED] [semantically similar]
  implementation_plan_ecommerce.md → PROJECT_MAP.md
- `E-Commerce Brain` --semantically_similar_to--> `Cafe Brain`  [INFERRED] [semantically similar]
  implementation_plan_ecommerce.md → PROJECT_MAP.md
- `Score-Based AI Gate` --semantically_similar_to--> `Zero-AI Multi-Tenant Cafe Chatbot`  [INFERRED] [semantically similar]
  SCORING_SYSTEM.md → README.md
- `Tenant Self-Serve Portal UI` --semantically_similar_to--> `Admin Dashboard UI (E-Glotech)`  [INFERRED] [semantically similar]
  portal/index.html → dashboard/index.html
- `Cafe Menu Public Link` --references--> `Cafe Brain`  [INFERRED]
  drive/sample-cafe/menu-public-link.txt → PROJECT_MAP.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Multi-Brain Vertical Routing** — project_map_multi_brain_registry, project_map_cafe_brain, project_map_clinic_brain, project_map_real_estate_brain, implementation_plan_ecommerce_brain [EXTRACTED 1.00]
- **NLP Query Recovery Cascade** — project_map_query_recovery_pipeline, project_map_heuristic_nlp_engine, scoring_system_score_based_gate [INFERRED 0.75]
- **Score Signal Aggregation** — scoring_system_negation_signal, scoring_system_pipeline_count_signal, scoring_system_recommendation_signal, scoring_system_modifier_signal, scoring_system_unknown_token_signal, scoring_system_question_type_signal [EXTRACTED 1.00]

## Communities (37 total, 1 thin omitted)

### Community 0 - "Brain Intent Matching & Query Recovery"
Cohesion: 0.05
Nodes (72): buildResponse(), detectIntent(), detectTargetSize(), findCafeItems(), { findMatchingCategories, findScoredItems, uniqueById, uniqueScoredByTitle }, { getBusinessItems }, getDisplayCategory(), getDisplayTitle() (+64 more)

### Community 1 - "Order Flow State Machine"
Cohesion: 0.05
Nodes (64): sendPayloadResult(), ACTIVE_ORDER_STATUSES, ADD_MORE_PATTERNS, addItemsToOrder(), applyOrderItemCommand(), attachOrderToSession, buildAddItemMessage(), buildAddressConfirmationMessage() (+56 more)

### Community 2 - "Portal Admin SPA"
Cohesion: 0.09
Nodes (47): api(), bootstrapPortal(), btnLoad(), collectBusinessPayload(), deleteCatalogItem(), esc(), exportOrders(), fillBusiness() (+39 more)

### Community 3 - "AI Routing & Gating"
Cohesion: 0.06
Nodes (46): tryAiPipeline(), ABBREVIATIONS, AI_TIMEOUT_MS, anyMatch(), assessAiRoutingNeed(), BASE_PIPELINES, buildAiSourceData(), buildMatcher() (+38 more)

### Community 4 - "Project Docs & Concepts"
Cohesion: 0.06
Nodes (49): CGC Report, Potential Dead Code, God Nodes (High Fan-In), Drive Folder Sample Guide, Sheet Sync Replaces Menu Items, E-Commerce Service Type Implementation Plan, E-Commerce Brain, API JSON Catalog Sync (+41 more)

### Community 5 - "E-Commerce Brain & AI Pipelines"
Cohesion: 0.08
Nodes (38): buildResponse(), detectCountry(), detectFeatureInquiry(), detectIntent(), FEATURE_LABELS, FEATURE_SYNONYMS, findEcommerceItems(), { findMatchingCategories, findScoredItems, uniqueById, uniqueScoredByTitle } (+30 more)

### Community 6 - "Chat Widget UI"
Cohesion: 0.13
Nodes (36): addCatalogItem(), appendMessage(), applyPayloadUi(), applyUiState(), buildWidget(), clearStoredSession(), createStyles(), emptyUiState() (+28 more)

### Community 7 - "Dashboard SPA Core"
Cohesion: 0.12
Nodes (27): api(), applyRouteFromHash(), collectCafePayload(), collectFaq(), fillEditor(), getCurrentPage(), getCurrentRoute(), hideLoader() (+19 more)

### Community 8 - "Message API Pipeline"
Cohesion: 0.07
Nodes (23): {
  assessAiRoutingNeed,
  callAiClassifier,
  isAiEnabledForBusiness,
  parseAiPipeline,
}, {
  buildNotFoundPayload,
  prefixAiFallbackPayload,
  resolveAiPipeline,
}, { canUseAi, recordAiUse }, { COMMON_RESPONSES }, db, { detectLanguage, normalizeArabicDigits }, express, { getBrain } (+15 more)

### Community 9 - "Dashboard Sessions & Orders UI"
Cohesion: 0.12
Nodes (24): deleteSession(), fetchSessionMessages(), getChatMessagesSignature(), getOrCreateBell(), loadOrders(), loadSessions(), normalizeMetadataForForm(), notificationState (+16 more)

### Community 10 - "Real Estate Brain"
Cohesion: 0.16
Nodes (22): buildFinanceSummary(), buildItemSuggestions(), buildPropertySummary(), buildResponse(), detectIntent(), { findMatchingCategories, findScoredItems, uniqueById, uniqueScoredByTitle }, findProperties(), { getBusinessItems } (+14 more)

### Community 11 - "Real Estate Sample Profile"
Cohesion: 0.08
Nodes (23): about_ar, about_en, active, address_ar, address_en, catalog_link, drive_folder_id, email (+15 more)

### Community 12 - "NPM Package & Dependencies"
Cohesion: 0.09
Nodes (22): dependencies, bcryptjs, cors, dotenv, express, express-rate-limit, googleapis, helmet (+14 more)

### Community 13 - "Business Admin API"
Cohesion: 0.10
Nodes (20): allBusinesses, { authMiddleware, adminOnly }, bcrypt, { COMMON_RESPONSES }, createBusiness, createUser, db, deleteBusiness (+12 more)

### Community 14 - "Cafe Sample Profile"
Cohesion: 0.10
Nodes (20): about_ar, about_en, address_ar, address_en, drive_folder_id, email, logo_url, menu_link (+12 more)

### Community 15 - "Session Init API"
Cohesion: 0.10
Nodes (16): { COMMON_RESPONSES }, createSession, db, { detectLanguage }, express, { getBrain }, getMessages, getSession (+8 more)

### Community 16 - "Cafe Admin API"
Cohesion: 0.11
Nodes (17): allCafes, { authMiddleware, adminOnly }, bcrypt, createCafe, createUser, crypto, db, deleteCafe (+9 more)

### Community 17 - "Catalog Store & Cache"
Cohesion: 0.15
Nodes (13): { authMiddleware }, db, express, { getBrain }, { invalidateBusinessItemsCache, parseMetadata }, { readRecordsFromSheet }, router, serializeItem() (+5 more)

### Community 18 - "SQLite Database Layer"
Cohesion: 0.18
Nodes (14): { DatabaseSync }, dataDir, db, dbPath, ensureColumn(), fs, getColumns(), hasColumn() (+6 more)

### Community 19 - "Google Sheets Sync"
Cohesion: 0.22
Nodes (12): fs, getAuth(), getReadableGoogleError(), { google }, mapRowsToRecords(), normalizeSheetId(), path, readPublicRecordsFromSheet() (+4 more)

### Community 20 - "Portal API Routes"
Cohesion: 0.17
Nodes (11): { COMMON_RESPONSES }, db, express, { getBrain }, { invalidateBusinessItemsCache, parseMetadata }, parseList(), { readRecordsFromSheet }, router (+3 more)

### Community 21 - "Auth & JWT Middleware"
Cohesion: 0.20
Nodes (10): { authMiddleware, signToken }, bcrypt, db, express, findUser, router, adminOnly(), authMiddleware() (+2 more)

### Community 22 - "AI Rate Limiter"
Cohesion: 0.21
Nodes (11): canUseAi(), checkScope(), countStmt, countWindow(), db, insertStmt, maybePrune(), PER_DAY (+3 more)

### Community 23 - "FAQ Matcher"
Cohesion: 0.24
Nodes (10): normalizeFaq(), FAQ_MIN_OVERLAP, GENERIC_WORDS, isDistinctive(), keywordsMatch(), matchFaq(), { normalize, tokenize }, parseFaqList() (+2 more)

### Community 24 - "Response Patterns & Responder"
Cohesion: 0.22
Nodes (5): PATTERNS, RESPONSES, buildResponse(), parseArray(), { RESPONSES }

### Community 25 - "Catalog Sync API"
Cohesion: 0.20
Nodes (9): db, deleteItems, express, { getBrain }, insertItem, { invalidateBusinessItemsCache }, { readRecordsFromSheet }, router (+1 more)

### Community 26 - "Session Lifecycle"
Cohesion: 0.27
Nodes (8): getBrain(), buildDefaultBusinessPayload(), buildFreshSessionMessages(), { COMMON_RESPONSES }, { getBrain }, isSessionExpired(), resetSessionState(), COMMON_RESPONSES

### Community 27 - "Menu Admin API"
Cohesion: 0.20
Nodes (7): { authMiddleware }, db, express, { invalidateMenuCache }, { readMenuFromSheet }, router, invalidateMenuCache()

### Community 28 - "Express Server Bootstrap"
Cohesion: 0.20
Nodes (9): app, chatLimiter, cors, express, helmet, morgan, path, PORT (+1 more)

### Community 29 - "Search API & Token Validation"
Cohesion: 0.25
Nodes (7): express, { matchItemsForOrder }, router, { tokenValidator }, db, getBusiness, tokenValidator()

### Community 30 - "Franco-Arabic Transliteration"
Cohesion: 0.25
Nodes (4): ARABIC_TO_ENGLISH_MAP, COMMON_ENGLISH, FRANCO_DICT, { levenshtein }

### Community 31 - "Brain Registry"
Cohesion: 0.29
Nodes (6): BRAINS, cafeBrain, clinicBrain, ecommerceBrain, listServiceTypes(), realEstateBrain

### Community 32 - "Database Admin Route"
Cohesion: 0.33
Nodes (4): db, express, path, router

### Community 33 - "Phone Validation"
Cohesion: 0.50
Nodes (4): looksLikeName(), normalizeArabicDigits(), { normalizeArabicDigits }, validatePhone()

### Community 34 - "Arabic-English Translation"
Cohesion: 0.40
Nodes (4): recoverFranco(), matchItemsForOrder(), ARABIC_TO_ENGLISH_DICT, translateArabicToEnglish()

### Community 35 - "Sample Menu Build Script"
Cohesion: 0.40
Nodes (4): csvPath, sheet, usedRange, xlsxPath

## Knowledge Gaps
- **339 isolated node(s):** `allow`, `state`, `mobileNavMedia`, `notificationState`, `name` (+334 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `normalize()` connect `Brain Intent Matching & Query Recovery` to `Phone Validation`, `Order Flow State Machine`, `AI Routing & Gating`, `E-Commerce Brain & AI Pipelines`, `Real Estate Brain`, `FAQ Matcher`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Why does `getBusinessItems()` connect `Order Flow State Machine` to `Brain Intent Matching & Query Recovery`, `Arabic-English Translation`, `AI Routing & Gating`, `E-Commerce Brain & AI Pipelines`, `Message API Pipeline`, `Real Estate Brain`, `Catalog Store & Cache`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `tokenize()` connect `Brain Intent Matching & Query Recovery` to `Real Estate Brain`, `AI Routing & Gating`, `E-Commerce Brain & AI Pipelines`, `FAQ Matcher`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `selectCafe()` (e.g. with `loadMenu()` and `startGlobalSessionsPoller()`) actually correct?**
  _`selectCafe()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `allow`, `state`, `mobileNavMedia` to the rest of the system?**
  _341 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Brain Intent Matching & Query Recovery` be split into smaller, more focused modules?**
  _Cohesion score 0.050837496326770495 - nodes in this community are weakly interconnected._
- **Should `Order Flow State Machine` be split into smaller, more focused modules?**
  _Cohesion score 0.05268065268065268 - nodes in this community are weakly interconnected._