# Changelog

All notable changes to `darwin-langgraph` are documented here.
The project adheres to [Semantic Versioning](https://semver.org/).

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
