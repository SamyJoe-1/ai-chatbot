# CGC Report

_Generated: 2026-05-20 06:05 UTC_


## God Nodes — Highest Fan-In
_These nodes are called from many places. High fan-in increases risk: a change here affects every caller._

| Kind | Name | File | In-degree |
| --- | --- | --- | --- |
|  | normalize | C:\Users\pc\ai-chatbot\src\engine\detector.js | 26 |
|  | esc | C:\Users\pc\ai-chatbot\dashboard\js\app-core.js | 23 |
|  | esc | C:\Users\pc\ai-chatbot\portal\js\app.js | 22 |
|  | tokenize | C:\Users\pc\ai-chatbot\src\engine\detector.js | 20 |
|  | api | C:\Users\pc\ai-chatbot\dashboard\js\app-core.js | 19 |
|  | toastErr | C:\Users\pc\ai-chatbot\dashboard\js\app-core.js | 18 |
|  | serializeOrderState | C:\Users\pc\ai-chatbot\src\engine\orderFlow.js | 17 |
|  | getDisplayTitle | C:\Users\pc\ai-chatbot\src\brains\realEstate.js | 17 |
|  | toast | C:\Users\pc\ai-chatbot\dashboard\js\app-core.js | 14 |
|  | matchesAny | C:\Users\pc\ai-chatbot\src\brains\clinic.js | 14 |
|  | api | C:\Users\pc\ai-chatbot\portal\js\app.js | 14 |
|  | toastErr | C:\Users\pc\ai-chatbot\portal\js\app.js | 13 |
|  | getOrderItems | C:\Users\pc\ai-chatbot\src\engine\orderFlow.js | 13 |
|  | matchesAny | C:\Users\pc\ai-chatbot\src\brains\cafe.js | 13 |
|  | matchesAny | C:\Users\pc\ai-chatbot\src\brains\realEstate.js | 13 |


## Potential Dead Code
_Functions with zero callers (not guaranteed dead — may be entry points or called via reflection)._

| Function | File |
| --- | --- |
| #login-form | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| -webkit-scrollbar | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| -webkit-scrollbar-thumb | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| -webkit-scrollbar-thumb | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| -webkit-scrollbar-track | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-arrow | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-body | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-body | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-container | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-header | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-header | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-header | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-header | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-header | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-section | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-section | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-section | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .accordion-section | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .active | C:\Users\pc\ai-chatbot\dashboard\css\app.css |
| .active | C:\Users\pc\ai-chatbot\dashboard\css\app.css |


## Suggested Cypher Queries
_Copy these into `execute_cypher_query` to explore further._

### Callers of a specific function
```cypher
MATCH (caller)-[:CALLS]->(fn:Function {name: 'yourFunctionName'})
RETURN caller.name, caller.path LIMIT 20
```

### Class hierarchy for a specific class
```cypher
MATCH path = (c:Class {name: 'YourClass'})-[:INHERITS*]->(parent)
RETURN [n IN nodes(path) | n.name] AS hierarchy
```

### Most-injected Spring beans
```cypher
MATCH ()-[:INJECTS]->(bean:Class)
RETURN bean.name, count(*) AS injection_count
ORDER BY injection_count DESC LIMIT 10
```

### All external library dependencies
```cypher
MATCH (m:MavenModule)-[:USES_LIBRARY]->(lib:ExternalLibrary)
RETURN m.artifact_id, lib.group_id, lib.artifact_id, lib.version
ORDER BY lib.artifact_id
```

### CALLS edges with low confidence (potential mis-resolutions)
```cypher
MATCH (a)-[c:CALLS]->(b)
WHERE c.confidence_label = 'AMBIGUOUS'
RETURN a.name, b.name, c.resolution_tier, a.path LIMIT 20
```
