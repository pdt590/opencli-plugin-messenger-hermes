# Graph Report - opencli-plugin-messenger-chatbot  (2026-11-03)

## Corpus Check
- 41 files · ~23,579 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 1 file(s) not represented in the graph (top: (none) 1)

## Summary
- 305 nodes · 751 edges · 12 communities
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 50 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Design Spec Concepts
- config.js
- OpenCLI Command Layer
- Business Suite UI Adapter
- Processing Pipeline Core
- watch.js
- ConversationStore
- Package Manifest
- Agent & Graphify Rules
- units.test.js
- install.sh
- uninstall.sh

## God Nodes (most connected - your core abstractions)
1. `ConversationStore` - 23 edges
2. `MessengerWebClient` - 21 edges
3. `withDeps()` - 17 edges
4. `loadConfig()` - 17 edges
5. `HermesRunner` - 16 edges
6. `processConversation()` - 16 edges
7. `UiError` - 13 edges
8. `ConfigError` - 12 edges
9. `FakeClient` - 12 edges
10. `Technical spec: OpenCLI Messenger - Hermes Agent` - 12 edges

## Surprising Connections (you probably didn't know these)
- `processCommand()` --calls--> `processConversation()`  [EXTRACTED]
  process.js → src/processor.js
- `reply()` --calls--> `normalizeText()`  [EXTRACTED]
  reply.js → src/messages.js
- `state()` --calls--> `withDeps()`  [EXTRACTED]
  state.js → src/cli-common.js
- `start()` --calls--> `loadConfig()`  [EXTRACTED]
  start.js → src/config.js
- `stop()` --calls--> `loadConfig()`  [EXTRACTED]
  stop.js → src/config.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Message processing pipeline modules** — design_system_inboxpoller, design_system_messengerwebclient, design_system_messagenormalizer, design_system_messagefilter, design_system_conversationstore, design_system_hermesrunner, design_system_replysender [EXTRACTED 1.00]
- **Conversation processing flow (page check, read, filter, Hermes, send, state)** — readme_page_check, readme_react_props_reading, readme_message_filter, readme_hermes_cli, readme_send_verification, readme_state_machine [EXTRACTED 1.00]
- **Duplicate-reply safeguards** — design_system_idempotency_message_key, design_system_no_blind_resend, readme_state_machine, readme_conversation_leases [INFERRED 0.85]

## Communities (12 total, 0 thin omitted)

### Community 0 - "Design Spec Concepts"
Cohesion: 0.06
Nodes (33): Acceptance criteria, ConversationStore, HermesRunner, Implementation sequence, InboxPoller, Internal message data contract, Logger, MessageFilter (+25 more)

### Community 1 - "config.js"
Cohesion: 0.23
Nodes (13): argv(), ConfigError, DEFAULT_INBOX_URL, DEFAULT_STATE_DIR, defaultHermesArgs(), int(), loadConfig(), parsePageUrl() (+5 more)

### Community 2 - "OpenCLI Command Layer"
Cohesion: 0.15
Nodes (32): inbox(), messages(), poll(), processCommand(), @jackwener/opencli, reply(), buildDeps(), DOMAIN (+24 more)

### Community 3 - "Business Suite UI Adapter"
Cohesion: 0.16
Nodes (12): clickSendButton(), focusComposer(), readOpenThread(), readPageIdentity(), readPageList(), readPageState(), readThreadList(), UiError (+4 more)

### Community 4 - "Processing Pipeline Core"
Cohesion: 0.09
Nodes (23): hermesSessionName(), BLOCKING_UI_CODES, CONTENT_FIELDS, Logger, newCorrelationId(), nullLogger, redact(), comparableText() (+15 more)

### Community 5 - "watch.js"
Cohesion: 0.13
Nodes (20): argv, config, dryRun, hermesProfile, logger, once, pageUrl, paths (+12 more)

### Community 6 - "ConversationStore"
Cohesion: 0.09
Nodes (13): ConversationStore, graphemes(), plannedDurationMs(), planTyping(), baseConfig(), FakeClient, FakeHermes, inbound() (+5 more)

### Community 7 - "Package Manifest"
Cohesion: 0.13
Nodes (14): description, engines, node, keywords, license, name, peerDependencies, @jackwener/opencli (+6 more)

### Community 8 - "Agent & Graphify Rules"
Cohesion: 0.40
Nodes (3): graphify skill (/graphify trigger), Repository Instructions (AGENTS.md), graphify-out knowledge graph

### Community 10 - "units.test.js"
Cohesion: 0.18
Nodes (10): candidateJson(), CREATION_ONLY, errorTail(), HermesError, HermesRunner, parseHermesOutput(), parseSessionId(), runProcess() (+2 more)

### Community 11 - "install.sh"
Cohesion: 0.60
Nodes (5): die(), info(), install.sh script, usage(), warn()

### Community 12 - "uninstall.sh"
Cohesion: 0.60
Nodes (5): die(), info(), uninstall.sh script, usage(), warn()

## Knowledge Gaps
- **12 isolated node(s):** `Acceptance criteria`, `Implementation sequence`, `OpenCLI plugin registry (cli, Strategy)`, `inbox command`, `messages command` (+7 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 82 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ConversationStore` connect `ConversationStore` to `OpenCLI Command Layer`, `Processing Pipeline Core`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **What connects `Acceptance criteria`, `Implementation sequence`, `OpenCLI plugin registry (cli, Strategy)` to the rest of the system?**
  _12 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Design Spec Concepts` be split into smaller, more focused modules?**
  _Cohesion score 0.05813953488372093 - nodes in this community are weakly interconnected._
- **Why does `@jackwener/opencli` connect `OpenCLI Command Layer` to `Package Manifest`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Should `Processing Pipeline Core` be split into smaller, more focused modules?**
  _Cohesion score 0.09080841638981174 - nodes in this community are weakly interconnected._
- **Why does `MessengerWebClient` connect `Business Suite UI Adapter` to `OpenCLI Command Layer`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Should `watch.js` be split into smaller, more focused modules?**
  _Cohesion score 0.12962962962962962 - nodes in this community are weakly interconnected._