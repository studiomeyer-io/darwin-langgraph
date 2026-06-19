# Changelog

All notable changes to `darwin-langgraph` are documented here.
The project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.0-alpha.1] — 2026-06-19

Compatibility + tracking release. **Zero breaking changes** — no public surface
changed; every V0.4 consumer keeps working unchanged.

### Changed

- **LangGraph 1.4.x verified.** Tested green against `@langchain/langgraph@1.4.4`
  (242/242 vitest). The peer range is now `^1.3.0 || ^1.4.0`. LangGraph 1.4.4
  ships an `ensureLangGraphConfig` fix that isolates concurrent singleton-agent
  invocations by thread; the adapter's `DarwinCallbackHandler` already keys all
  state on the per-invoke LangChain `runId`, so it composes cleanly with it.
- **darwin-agents peer widened** to `>=0.5.0-alpha.1 <0.8.0` to track
  `darwin-agents@0.7.0-alpha.1` (statistical-rigor + coverage-sampling wave). The
  re-exported `ExecutionTrace` / trajectory types are unchanged, so the adapter
  is compatible across darwin-agents 0.5 → 0.7.

### Added

- **Concurrent-isolation regression test** — two parallel `graph.invoke()` runs
  with distinct trajectories now assert each `onTrajectory` event carries its
  OWN trajectory mapped to the correct node/agent (no cross-leak), guarding the
  LangGraph 1.4.x concurrent-singleton behaviour explicitly.

## [0.4.0-alpha.1] — 2026-05-29

V0.4 is an additive release that closes the V0.3 R2 deferrals and lands
nine new surfaces driven by a research sweep across LangGraph 1.3, the
OpenTelemetry GenAI Semantic Conventions registry, and the LangGraph
TypeScript Production Guide. **Zero breaking changes** — every existing
V0.3 consumer keeps working unchanged.

### Added — nine new surfaces

- **`DarwinCallbackHandler.onToolEvent`** — new option that fires for
  every LangGraph tool-chain start / end / error inside a tracked node.
  Emits a `DarwinToolEvent` (`phase: "start" | "end" | "error"`) with
  `toolName`, `runId`, `parentRunId`, plus `input` / `output` / `error`
  depending on phase. Use it to emit per-tool OTEL spans, drive progress
  UIs, or wire abort-on-tool-failure logic. The handler now also caches
  tool names internally so end / error events get the same name the
  start event reported, even when the LangChain tool-end signature does
  not carry the name (LangChain 0.3 quirk).
- **`DarwinCallbackHandler` `maxTrajectoryBytes`** — soft cap (default
  `262_144` = 256 KiB) on the serialised trajectory size emitted via
  `onTrajectory`. Oversized trajectories are replaced with a
  structurally-compatible BUT minimal stub (counts + `capturedAt` +
  `tokenUsage` preserved, `toolCalls` / `errors` replaced with empty
  arrays). The event payload gains a new `trajectoryTruncated: true`
  field so consumers can branch. Circular-reference trajectories are
  caught defensively and treated as oversized. `tokenUsage` is shallow-
  copied and `bigint` token counters are coerced to `number` so
  downstream `JSON.stringify` never trips.
- **`MAX_KNOWN_TRACE_VERSION` + forward-compat `isExecutionTrace`** —
  the handler now accepts `version >= 1` and warns once per process when
  a higher-than-known version is observed. The accumulator reducer,
  `withDarwinEvolution`, and `toOtelAttributes` all share the same
  widening so a future `darwin-agents` schema bump does not silently
  drop trajectories anywhere on the pipeline.
- **`toOtelAttributes` LangGraph + OTel cross-cutting attributes** —
  four new options. `langGraphNode` and `langGraphStep` emit
  `gen_ai.langgraph.node` / `gen_ai.langgraph.step` per the Coralogix /
  Last9 / Honeycomb LangGraph instrumentation convention. `userId` emits
  BOTH the OTel-spec-canonical `enduser.id` (cross-cutting) AND the
  historical alias `gen_ai.request.user` so dashboards on either
  convention keep working. `conversationId` emits the spec-correct
  `gen_ai.conversation.id` (typically the LangGraph `thread_id`).
  `requestId` emits `gen_ai.request.id`.
- **`createDarwinNode.onAttempt`** — config-aware passthrough that
  fires before `runAgent` with the runtime info LangGraph surfaces.
  Reads `nodeAttempt` from `config.runtime.executionInfo` (per
  LangGraph PR #7363, surfacing `1` on first execution and incrementing
  per retry under an `addNode(name, fn, { retryPolicy })` policy),
  `nodeFirstAttemptTime` from the same source (per PR #7363 for
  retry-latency computation), `langGraphStep` from
  `config.metadata.langgraph_step` (the canonical LangGraph 1.3 source —
  NOT `executionInfo`), and `threadId` from `config.configurable.thread_id`.
  Pairs naturally with LangGraph's native `retryPolicy` without adding
  a competing retry layer.
- **`darwinAccumulatingAnnotation`** + **`darwinTrajectoryAccumulatorReducer`**
  + **`getDarwinAccumulatingChannelSpec`** — variant of `darwinAnnotation`
  that replaces the singleton `darwinTrajectory: ExecutionTrace | undefined`
  channel with an accumulating `darwinTrajectories: ExecutionTrace[]`
  channel. Use it when you orchestrate multiple Darwin nodes in a graph
  (fan-out, sequential pipeline, supervisor) and want every trajectory
  preserved in state without declaring a per-node trace channel by
  hand. The reducer accepts a single `ExecutionTrace` (matching the
  bare `createDarwinNode` contract) or `ExecutionTrace[]` (batch
  append) and drops non-`version >= 1` shapes defensively. The
  annotation throws when the optional `extra` argument tries to redefine
  one of the Darwin-managed channels (`task`, `output`,
  `darwinTrajectories`) — a previously silent contract footgun.
- **`createTokenBudgetCallbacks(opts)`** + **`TokenBudgetCallbackHandler`**
  + **`DarwinTokenBudgetExceededError`** — production-pattern from the
  LangGraph TypeScript Production Guide. Enforces a per-invocation
  token budget across all LLM calls inside the graph. Extracts tokens
  from `output.llmOutput.tokenUsage.totalTokens` (LangChain canonical
  for ChatOpenAI / ChatAnthropic) and falls back to summing per-message
  `generations[][].message.usage_metadata` (Anthropic native + others).
  Throws the typed `DarwinTokenBudgetExceededError` on breach so
  callers can `instanceof`-check without parsing message text.
  `awaitHandlers = true` so LangChain awaits the handler and the
  synchronous throw reliably reaches the `graph.invoke` caller.
  Constructor validates the budget is a finite positive integer
  (NaN / Infinity / 0 / negative / non-integer all throw eagerly).
- **`toW3CTraceContext(event, opts?)`** — pure mapper from
  `DarwinTrajectoryEvent` to a [W3C Trace Context](https://www.w3.org/TR/trace-context/)
  `traceparent` header value (`00-<32hex>-<16hex>-(00|01)`). When the
  event has no `parentRunId`, the spanId is taken from the SECOND 16
  hex of the runId so it is never a prefix of the traceId — several
  OTEL backends (Datadog APM, Honeycomb classic) reject or misroute
  spans whose ids look like self-parents. When the event has a valid
  `parentRunId`, the traceId is taken from the parent and the spanId
  from the first 16 hex of the runId. Returns `undefined` for malformed
  / non-UUID runIds and for the all-zero strings the W3C spec forbids.
- **Example 04 — OTEL + W3C + token budget**
  (`examples/04-otel-and-budget.ts`). End-to-end wiring of every new
  V0.4 surface against a console-only span emitter so the example
  runs without external services; swap in a real OTLP exporter or
  Langfuse SDK at the marked line.

### Added — error class

- **`DarwinTokenBudgetExceededError`** — thrown by
  `TokenBudgetCallbackHandler` on breach AND eagerly on construction
  when the configured budget is invalid. Exposes `budget`, `totalTokens`,
  and `providerHint` (`modelName` / `model_name` extracted from the
  LLMResult when present) so callers can branch on cost / provider.

### Changed

- **`DarwinTrajectoryEvent` extended** with optional `trajectoryTruncated`
  field — set to `true` when `DarwinCallbackHandler.maxTrajectoryBytes`
  replaces the trajectory with a stub. Omitted (not `false`) when the
  trajectory passed through unchanged.
- **`InFlightRun` shape** in `DarwinCallbackHandler` — internal change,
  the `runIdToName` map now stores `{ nodeName, parentRunId, pendingTools,
  finalized }`. The two new fields drive the R1 P1-4 fix that keeps
  chain entries alive past `handleChainEnd` until pending tool events
  have surfaced so `onToolEvent` callbacks for late-completing tools
  are no longer silently dropped.
- **VERSION constant bumped** to `0.4.0-alpha.1` in both `package.json`
  and `src/index.ts` (verified by `prepublishOnly` script).

### Fixed (R1 + R2 code-review-loop pre-publish)

A three-agent R1 review (Critic + Analyst + Research) followed by an
R2 critic verification + R3 grep self-check surfaced and closed ten
issues before publish:

- **P0-1 — W3C trace context self-parent collision.** Top-level
  invokes derived BOTH `traceId` and `spanId` from the first 16 chars
  of the same UUID, producing `traceparent` headers where the spanId
  was a prefix of the traceId. Several OTEL backends reject those as
  self-parents. Fix: when no `parentRunId`, `spanId = runHex.slice(16, 32)`.
- **P0-2 — Forward-compat version drift.** The accumulator reducer
  strict-equality-checked `version === 1` while `isExecutionTrace`
  accepted `version >= 1`. The same widening was also missed in
  `toOtelAttributes` and the legacy `withDarwinEvolution` wrapper.
  All four sites now share the same `version >= 1 && Number.isFinite`
  gate so a v=2 trajectory flows through every code path consistently.
- **P1-1 — Tool name lost between start and end.** `handleToolEnd`
  tried to read `output.name`, which is absent for the common
  `ToolNode` case (output is a plain string). Fix: cache the name
  from `handleToolStart` keyed by tool runId; consume it in
  `handleToolEnd` / `handleToolError`. Falls back to `output.name`
  when the start was missed.
- **P1-2 — `buildTruncatedTrace` aliased original `tokenUsage`.**
  The stub kept a reference to the original (potentially `bigint`-
  carrying) `tokenUsage` object, breaking downstream `JSON.stringify`.
  Fix: shallow copy via `Object.fromEntries(Object.entries(...))` and
  coerce `bigint` values to `number`.
- **P1-4 — Pending tool events vs `handleChainEnd` race.** Chains
  with long-running tools sometimes saw `handleChainEnd` synchronously
  delete the `runIdToName` entry before the matching
  `handleToolEnd` / `handleToolError` arrived. Fix: reference-count
  pending tools per chain (`InFlightRun.pendingTools`). `handleChainEnd`
  marks the entry `finalized` instead of deleting it; the last tool
  callback drains a deferred trajectory dispatch and cleans up.
- **Research-1 — `gen_ai.request.user` is not OTel-canonical.** The
  GenAI semconv registry defines `gen_ai.conversation.id` and the
  cross-cutting `enduser.id` for user / session identity, not
  `gen_ai.request.user`. Fix: emit both the canonical `enduser.id`
  AND the historical alias `gen_ai.request.user` (older Coralogix /
  Last9 dashboards key off the alias). New `conversationId` option
  emits the spec-correct `gen_ai.conversation.id`.
- **Research-2 — `langGraphStep` source path corrected.** LangGraph
  1.3 surfaces the step counter in `config.metadata.langgraph_step`,
  not `executionInfo.langGraphStep`. Fix: `createDarwinNode` reads
  from the correct path and additionally surfaces
  `nodeFirstAttemptTime` from `executionInfo` (per LangGraph PR
  #7363) for retry-latency math.
- **P2-2 — `darwinAccumulatingAnnotation` reserved-key silent
  overwrite.** Passing `extra = { darwinTrajectories: customAnnotation }`
  silently replaced the accumulator channel with no warning. Fix:
  throws on any `extra` key that conflicts with `task` / `output` /
  `darwinTrajectories`.
- **P2-3 — `TokenBudgetCallbackHandler.awaitHandlers = false`.**
  With `awaitHandlers = false` LangChain may not await the handler;
  the synchronous throw inside `handleLLMEnd` could surface as an
  unhandled rejection rather than aborting the graph. Fix:
  `awaitHandlers = true` (the throw IS the abort signal).
- **R2 MUST-FIX — `toOtelAttributes` strict version guard.** The R1
  P0-2 widening was applied to the accumulator reducer and the
  callback-handler `isExecutionTrace` but missed in `toOtelAttributes`
  (which still threw `TypeError` on v=2 trajectories). The R2 critic
  caught it; the same forward-compat guard now lives in all four
  trajectory consumers.

### Test coverage

- **241/241 vitest tests green** (was 132 in V0.3, **+109 V0.4 tests**
  across `tests/token-budget.test.ts`, `tests/to-w3c-trace-context.test.ts`,
  `tests/darwin-accumulating-annotation.test.ts`, `tests/v04-features.test.ts`,
  `tests/r1-v04-fixes.test.ts`).
- New regression-test file `tests/r1-v04-fixes.test.ts` (28 tests across
  10 R1+R2 fix groups) pins each fix so a future patch cannot regress
  the corrected behaviour silently.
- `tsc --strict --noEmit` clean (src + examples).
- `npm run build` clean — all V0.4 surface additions ship in `dist/`.

### V0.5 backlog (deferred from R1 + R2)

- **Per-tool size cap** alongside `maxTrajectoryBytes` (instead of the
  per-trajectory level — surgical truncation of one fat tool result
  rather than the whole agent).
- **`gen_ai.provider.name` + `gen_ai.request.model` + `gen_ai.response.model`
  + `gen_ai.response.finish_reasons`** — spec-required OTel GenAI
  attributes V0.4 does not yet emit.
- **`gen_ai.workflow.*` parallel emission** — Traceloop RFC #3460
  proposes `gen_ai.workflow.current_node` as the canonical successor
  to `gen_ai.langgraph.node`. Emit both during the transition.
- **`gen_ai.usage.reasoning.output_tokens`** for Claude extended
  thinking / Opus 4.x reasoning models.
- **`gen_ai.usage.cache_*` rollup into the token-budget total** with
  an `countCacheTokens?: boolean` flag — Anthropic prompt caching can
  shift 90% of effective tokens into the cache bucket.
- **Bedrock LLMResult shape** in `extractTokenDelta` (third branch
  alongside ChatOpenAI canonical + per-message `usage_metadata`).
- **`getMessagesAccumulatingChannelSpec`** + companion
  `darwinMessagesAccumulatingAnnotation` for graphs mixing
  `createReactAgent` with multi-Darwin fan-out.
- **Explicit `@langchain/core` peer dep declaration** in `package.json`
  (currently implicit via `@langchain/langgraph` peer dep).
- **`MAX_KNOWN_TRACE_VERSION` migration to `darwin-agents`** — let the
  upstream library own the constant so the adapter dependency drift
  becomes a peer-dep semver failure rather than a runtime warn.
- **`tools/list` notification handler** in `streamEvents` v3 — separate
  V0.5 surface that fires on tool-list changes without polling.
- **`tool_result` content-block streaming events** when LangGraph 1.4
  surfaces them through the callback contract.

### Migration from V0.3

None required. V0.4 is additive. Existing consumers can adopt the new
surfaces incrementally:

- Adopt `DarwinCallbackHandler.onToolEvent` to emit per-tool spans.
- Wrap `graph.invoke` with `createTokenBudgetCallbacks(...)` to enforce
  a cost ceiling.
- Pass `event` through `toW3CTraceContext(event)` and attach the
  `traceparent` header to outgoing HTTP calls for cross-process span
  correlation.
- Swap `darwinAnnotation()` for `darwinAccumulatingAnnotation()` when
  you orchestrate more than one Darwin node and want every trajectory
  preserved.

## [0.3.0-alpha.1] — 2026-05-25

V0.3 closes the three deferred items from V0.2's R2 review (parent-run
propagation, double-wrap detection, hung-invoke guard) and lifts the
repository to the StudioMeyer open-source-standard documentation layout
(CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, ECOSYSTEM, issue + PR
templates, GitHub Actions CI matrix on Node 20 + 22).

### Added — three new behaviours + one new option

- **`DarwinTrajectoryEvent.runId` + `.parentRunId`** — propagated by
  `DarwinCallbackHandler` from the LangChain callback contract. Lets
  downstream consumers (OTEL exporters, Langfuse, LangSmith, custom
  span-tree loggers) rebuild the chain hierarchy from the event payload
  alone without a separate runId-tracking side-channel. `runId` is
  always present on V0.2+ handler events; `parentRunId` is present
  only when the chain has a parent (omitted for top-level invokes).
- **`withDarwinEvolution` double-wrap warning** — a `Symbol.for(...)`
  sentinel is stamped on each wrapped graph. A second wrap of the same
  graph instance now emits a one-shot `console.warn` flagging the
  duplicate-hook footgun. The wrap still succeeds (some users legitimately
  layer multiple `nodeMap` slices), but the silent-double-fire case
  is now visible in logs.
- **`DarwinCallbackHandler` hung-invoke guard** — new option
  `maxInFlightRuns?: number` on `DarwinCallbackHandlerOptions`. Caps the
  internal `runId → InFlightRun` map. When the cap is exceeded the
  oldest entry is evicted (LRU via Map insertion order) and a
  one-shot warning fires. Defaults to 1024 — small enough to surface
  real leaks within minutes, large enough for typical fan-out. Set to
  `Infinity` to opt out.

### Changed

- **`DarwinCallbackHandlerOptions` type exported** alongside
  `DarwinCallbackHandler`. Was internal in V0.2; now a public type so
  consumers can build wrapper handlers without re-declaring the shape.
- **`InFlightRun` shape** — internal change in `DarwinCallbackHandler`:
  the `runIdToName` map now stores `{ nodeName, parentRunId }` rather
  than just the name string, to carry parentRunId through to
  `handleChainEnd`. Non-breaking — only the internal field type changed.
- **VERSION constant bumped** to `0.3.0-alpha.1` in both `package.json`
  and `src/index.ts` (verified by `prepublishOnly` script).

### Added — open-source documentation standard

The repo now matches the
[`temporal-memory-workflows`](https://github.com/studiomeyer-io/temporal-memory-workflows)
OS-standard layout. New top-level files:

- **`CONTRIBUTING.md`** — folder layout, code-review expectations, PR
  format, Conventional Commits convention, deprecation contract on
  `withDarwinEvolution`, adapter-vs-upstream-bugs separation.
- **`CODE_OF_CONDUCT.md`** — adapted from Contributor Covenant 2.1.
- **`SECURITY.md`** — disclosure policy, supported versions
  (`0.3.x` + `0.2.x` security-only), supply-chain stance (no
  postinstall scripts), defense-in-depth layer breakdown.
- **`ECOSYSTEM.md`** — where the adapter sits in the StudioMeyer
  toolkit, pairing notes with `darwin-agents` /
  `@langchain/langgraph` / `temporal-memory-workflows`, when-to-use-what
  decision table, sibling-repo links.
- **`.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml`**
  — surface-aware bug template, problem-first feature template, contact
  links routing to upstream where appropriate.
- **`.github/PULL_REQUEST_TEMPLATE.md`** — surface checklist,
  zero-hard-dep check, deprecation-contract check, R1/R2 code-review
  trail field for maintainers.
- **`.github/workflows/ci.yml`** — Node 20 + 22 matrix, runs
  `npm ci` → `verify-version-sync` → `typecheck` → `examples:check` →
  `test` → `build` on every push to `main` and every PR.

### Test coverage

- **132/132 vitest tests green** (was 116 in V0.2, **+16 V0.3 tests**).
- New test file: `tests/v03-features.test.ts` (16 tests across 4 groups:
  parent-run propagation, double-wrap warning, hung-invoke timeout
  guard, `vi.resetModules()` pattern for module-level flag tests).
- tsc strict + examples typecheck + version-sync + build all clean.
- No regressions: all V0.1 + V0.2 surface tests + R1 + R2 fixes still
  green.

### Migration notes

- **From V0.2.x → V0.3.x:** No code changes required. The
  `runId`/`parentRunId` fields on `DarwinTrajectoryEvent` are optional
  additions; existing callbacks ignore them. The double-wrap warning
  only fires if you actually double-wrap (most users do not). The
  default `maxInFlightRuns: 1024` cap is invisible in normal use.
- **From V0.1.x → V0.3.x:** Still recommended to migrate from
  `withDarwinEvolution` to `DarwinCallbackHandler` — see V0.2
  migration notes in this changelog.

### V0.4 Roadmap (deferred)

- **`reflectionRunPrompt` override on `darwin-agents` (paper-fidelity).**
  The GEPA paper uses a stronger reflection LM than the task LM. Currently
  the adapter inherits `darwin-agents@0.5.0-alpha.2`'s single-`runPrompt`
  implementation. Defer to a paired bump.
- **OTEL exporter binding helper** — turn the pure `toOtelAttributes`
  mapping into a one-liner that registers a span per trajectory with
  a configured tracer.
- **Langfuse handler subclass** — `DarwinLangfuseHandler` that extends
  `DarwinCallbackHandler` and emits Langfuse traces directly.
- **LangSmith trace correlation** — propagate `runId`/`parentRunId`
  into a LangSmith-compatible attribute set.

## [0.2.0-alpha.1] — 2026-05-25

### Added — three new surfaces (V0.1 roadmap → LIVE)

- **Surface 4: `DarwinCallbackHandler`** — LangChain-native replacement
  for `withDarwinEvolution`. Subclass of `BaseCallbackHandler` from
  `@langchain/core/callbacks/base`. Pass via
  `graph.invoke(input, { callbacks: [new DarwinCallbackHandler({ nodeMap,
  onTrajectory }) ] })`. No monkey-patching of `invoke` / `stream`,
  no `Set<symbol>` race-fix needed, no `streamMode` warn — works
  identically across `invoke`, `stream` (any `streamMode`), and
  `streamEvents`. Uses `metadata.langgraph_node` as the primary
  node-name source (live-verified against `@langchain/langgraph@1.3.x`)
  with the `runName` parameter as fallback for non-LangGraph chains.
- **Surface 5: `toOtelAttributes(trajectory, opts?)` +
  `toolCallToOtelAttributes(call, opts?)`** — pure mappers from Darwin's
  `ExecutionTrace` to flat `Record<string, string|number|boolean>` keyed
  by [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).
  Spec-compliant cache attribute names
  (`gen_ai.usage.cache_read.input_tokens` /
  `gen_ai.usage.cache_creation.input_tokens`). MCP tools correctly map
  to `gen_ai.tool.type = "extension"` (server-side, calls external APIs)
  vs `"function"` for builtins. Sensitive `arguments` / `result` fields
  are opt-in per OTEL spec. NaN/Infinity values dropped from output
  (OTEL exporter compliance).
- **Surface 6: `darwinMessagesAnnotation(extra?)`** — variant of
  `darwinAnnotation` that also includes LangGraph's canonical `messages`
  channel (`messagesStateReducer`). Use it when your graph mixes Darwin
  agents with `createReactAgent` / `MessagesAnnotation`-based prebuilt
  agents. Power-user escape hatch `getMessagesChannelSpec()` exposed
  for manual `Annotation.Root` composition.

### Changed

- **`withDarwinEvolution` is `@deprecated` since v0.2.0** — JSDoc tag
  plus a one-shot `console.warn` on first call (process-level, never
  spam). Will be **removed in v1.0.0**. Migration is two lines (see
  README "Migration from v0.1.x to v0.2.x").
- **VERSION constant bumped** to `0.2.0-alpha.1` in both `package.json`
  and `src/index.ts` (verified by `prepublishOnly` script).

### Fixed (R1 + R2 V0.2 code-review findings, all in-place pre-publish)

The 3-Agent code-review loop ran twice on V0.2. R1 surfaced 10 findings,
R2 caught 1 HIGH that R1 missed. All addressed before this release.

**R1 — 6 MUST-FIX (S1185):**

1. **CRITICAL (Critic 1):** `firedRuns: Set<string>` in
   `DarwinCallbackHandler` was an unbounded memory leak for long-lived
   handlers (e.g. server singletons). Removed — `runIdToName.delete` is
   the sole dedup and LangGraph guarantees one `handleChainEnd` per
   `runId`.
2. **HIGH (Critic 2):** `isExecutionTrace` only checked `version === 1`
   — a malformed trajectory could pass and crash downstream
   `toOtelAttributes(trajectory.toolCalls.length)`. Guard now also
   requires `Array.isArray(toolCalls)` + `Array.isArray(errors)`.
   `toOtelAttributes` got defensive fallbacks too.
3. **HIGH (Critic 3 + 7):** `typeof === "number"` passed `NaN` and
   `Infinity` through to OTEL exporters (silent span drop). All numeric
   attributes (token usage, durationMs, turn, textBlockCount, turnCount,
   mcpInvocations) now use `Number.isFinite`.
4. **HIGH (Research 1):** OTEL spec uses
   `gen_ai.usage.cache_read.input_tokens` /
   `cache_creation.input_tokens` per the official attribute registry,
   not the short `cache_*_tokens` form we initially emitted. Fixed
   pre-release (zero-cost rename in alpha).
5. **HIGH (Research 3):** MCP tools execute server-side and call
   external APIs — `gen_ai.tool.type` must be `"extension"`, not
   `"function"`. Adapter now routes on the existing `is_mcp` heuristic.
6. **MED (Critic 5):** `swallow(err)` used `if (warned || !err)` which
   silently dropped falsy throws (`throw null` etc). Fixed in
   `DarwinCallbackHandler.swallow`.

**R2 — 1 HIGH (caught what R1 missed, S1185):**

7. **HIGH (R2 Critic R2-1):** R1's fix #6 was applied to
   `DarwinCallbackHandler.swallow` but NOT to the parallel `swallow`
   inside `withDarwinEvolution`. Both now consistent.

### Known limitations carried to V0.3

- **`withDarwinEvolution` module-level deprecation flag** is not reset
  across tests in the same process (R2 Critic R2-2). Acceptable for
  one-shot warn semantics; testing the contract requires
  `vi.resetModules()`.
- **Double-wrapping `withDarwinEvolution` on the same graph instance**
  is unsupported and produces no clear error (R2 Critic R2-3). Use
  `DarwinCallbackHandler` instead — composable by default.
- **Parent-run propagation** on `DarwinTrajectoryEvent` not exposed
  yet (R1 Research 5). Planned for V0.3 — needs use-case validation.

### Test coverage

- **116/116 vitest tests green** (was 63 in V0.1).
- New test files: `tests/darwin-callback-handler.test.ts` (14),
  `tests/to-otel-attributes.test.ts` (18),
  `tests/darwin-messages-annotation.test.ts` (7),
  `tests/r2-v02-fixes.test.ts` (10 R1+R2 regression).
- tsc strict + examples typecheck + version-sync + build all clean.

## [0.1.0-alpha.1] — 2026-05-24

### Added

- **Surface 1: `createDarwinNode(agent, opts?)`** — wraps a Darwin
  `AgentDefinition` as a LangGraph `NodeAction`. Reads the task from state,
  runs the agent via `darwin-agents.runAgent()`, writes `output` and (opt-in)
  the captured `ExecutionTrace` back to state.
- **Surface 2: `darwinAnnotation(extra?)`** — `Annotation.Root` helper with
  three pre-defined channels (`task`, `output`, `darwinTrajectory`).
  Composable via `extra` for user channels.
- **Surface 3: `withDarwinEvolution(graph, opts)`** — wraps a compiled
  `StateGraph`'s `invoke` / `stream` methods with a fire-and-forget post-run
  hook that forwards each node's trajectory to a user-supplied callback,
  enabling Darwin's closed-loop A/B evolution without changing graph code.
- **Custom errors:** `DarwinNodeError`, `DarwinEvolutionHookError` — subclass
  `Error` for `instanceof` checks.
- **Types:** Re-export of `AgentDefinition`, `ExecutionTrace`, `RunResult`,
  `MemoryProvider`, `TraceToolCall`, `TraceTokenUsage`, `TraceTurnError`
  from `darwin-agents` for ergonomic single-import.

### Compatibility

| `darwin-langgraph` | `darwin-agents` | `@langchain/langgraph` |
|---|---|---|
| `0.1.0-alpha.x` | `^0.5.0-alpha.1` | `^1.3.0` |

Both upstream packages are declared as **peer-dependencies** — the consumer
controls the installed versions and the adapter never pins them.

### Notes

- Released under the `alpha` npm dist-tag in parallel with
  `darwin-agents@0.5.0-alpha.1` (the first release that ships
  `ExecutionTrace` capture). Because `0.1.0-alpha.1` is the very
  first publish of this package, npm assigns BOTH `alpha` and
  `latest` to it (npm rule: `latest` always exists), so
  `npm install darwin-langgraph` resolves to the alpha version
  until `0.1.0` final ships. Prefer the explicit
  `npm install darwin-langgraph@alpha` form for clarity.
- The adapter never touches `ANTHROPIC_API_KEY`. If you run Darwin on a
  Claude Max subscription via the Claude Code CLI, set `delete
  process.env.ANTHROPIC_API_KEY` in your own bootstrap.
- **Peer-dep semver caveat:** `darwin-agents: "^0.5.0-alpha.1"` follows
  npm's prerelease semver rules — `0.5.0-alpha.N` and `0.5.0` final
  satisfy it, but `0.5.1-alpha.0` does NOT. A patch release of this
  adapter will be required when `darwin-agents` bumps past `0.5.x`.

### R1 + R2 Code-Review Loop Pre-Publish

The 3-Agent code-review loop (Critic + Analyst + Research, in parallel)
ran twice before this release. R1 surfaced 8 findings, all fixed
in-place. R2 surfaced 1 HIGH must-fix + 4 LOW deferrals, the must-fix
landed in this release. The 9 R1 + 4 R2 regression tests live in
[`tests/r1-fixes.test.ts`](./tests/r1-fixes.test.ts).

**R2 MUST-FIX (S1185):**

- **HIGH (R2 Research 1):** the R1 hand-rolled `isGraphInterrupt`
  duck-type missed `NodeInterrupt` (a `GraphInterrupt` subclass that
  is the ACTUAL error thrown by `interrupt()` inside a node) AND broke
  under bundler minification when `keep_classnames` was off. Fix:
  import `isGraphInterrupt` directly from `@langchain/langgraph`'s
  main entry (a stable public export that uses LangGraph's internal
  `unminifiable_name` static-getter pattern). 12 LOC of hand-rolled
  helper deleted, 1 line of named import added. Tests now use real
  `GraphInterrupt` + `NodeInterrupt` instances.
- **LOW (R2 Critic 3):** added a comment block in `wrappedStream`
  explaining the `activeInvokeMarkers.size > 0` ordering invariant
  so future maintainers don't misread the race-free pattern.
- **LOW (R2 Analyst):** fixed stale README design-note line that still
  said "counter" instead of "`Set<symbol>`".

**R1-Fixes (8 findings):**

1. **CRITICAL (Critic 1):** `withDarwinEvolution` shared-counter race —
   replaced `let invokesInFlight = 0` with `Set<symbol>` so concurrent
   `Promise.all([graph.invoke, graph.invoke])` calls fire `onTrajectory`
   exactly once each instead of double-firing. Regression test in
   `tests/r1-fixes.test.ts`.
2. **HIGH (Critic 2):** `stream({ streamMode: "updates" })` silently
   skipped hook — adapter now `console.warn`s once when streamMode is
   not `"values"`, surfacing the contract gap to users.
3. **HIGH (Research 5):** `runAgent`-throws of `GraphInterrupt`
   (LangGraph HITL signal) were getting wrapped in `DarwinNodeError`,
   breaking the resume protocol. `createDarwinNode` now duck-types the
   `name` / `constructor.name` field and re-throws untouched.
4. **MEDIUM (Critic 4):** `Object.freeze({...stateObj})` is shallow.
   JSDoc on `DarwinTrajectoryEvent.finalState` now says so explicitly
   and points to "treat nested values as immutable by convention."
5. **MEDIUM (Critic 6):** Added explicit test for
   `result.experiment.trajectory === null` (not just `undefined`).
6. **MEDIUM (Critic 7):** Added `verify:version-sync` script that the
   `prepublishOnly` step runs — refuses to publish when `package.json`
   and `src/index.ts` `VERSION` constant drift.
7. **MEDIUM (Critic 8, Analyst 4):** Example 02 + 03 now warn about
   `taskKey` shadowing and `MemorySaver` being dev-only.
8. **LOW (Research 6):** `peerDependenciesMeta` stanza added
   (both peers marked `optional: false` explicitly).

### V0.2 Roadmap (deferred from R1 review)

- **`DarwinCallbackHandler` migration** (Research 2): drop the
  `invoke`/`stream` monkey-patch in `withDarwinEvolution` in favour of
  LangChain's `BaseCallbackHandler` registered via `graph.invoke(input,
  { callbacks: [...] })`. Outlives any LangGraph-internal API shuffle.
- **`toOtelAttributes(trajectory)` helper** (Research 3): map Darwin's
  `ExecutionTrace` to OpenTelemetry GenAI Semantic Conventions
  (`gen_ai.usage.input_tokens`, `gen_ai.agent.name`, etc.) so Langfuse /
  Braintrust / Datadog integrate out-of-the-box.
- **`darwinMessagesAnnotation()`** (Research 7): variant that merges
  Darwin's three channels with LangGraph's `MessagesAnnotation.spec` so
  mixing `createReactAgent` and `createDarwinNode` in one graph works
  without channel-name conflicts.
- **`onResult` vs `onTrajectory` README paragraph** (Analyst 2):
  explicit "when to pick which" guidance. Currently covered in JSDoc
  only.
