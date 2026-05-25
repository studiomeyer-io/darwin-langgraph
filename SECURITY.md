# Security Policy

## Supported versions

This repository ships a single adapter package: `darwin-langgraph`. We patch security issues
only on the latest minor release line (currently `0.3.x` alpha).

| Version | Supported           |
| ------- | ------------------- |
| 0.3.x   | Yes (current alpha) |
| 0.2.x   | Yes (security only) |
| 0.1.x   | No (alpha pre-V0.2) |
| < 0.1   | No                  |

The `main` branch always reflects the latest supported state. Older tags exist for
reproducibility but receive no patches.

## Reporting a vulnerability

If you find a security issue in the adapter package, in how it handles untrusted input
(LangGraph state values, Darwin trajectory content, OTEL attribute values), or in how it
interacts with the LangChain callback contract, **do not open a public GitHub issue**.

Instead, report it privately:

- **Email:** `matthias10121980meyer@gmail.com`
- **Subject:** `[SECURITY] darwin-langgraph`

Please include:

1. Which surface (`createDarwinNode`, `darwinAnnotation`, `withDarwinEvolution`,
   `DarwinCallbackHandler`, `toOtelAttributes`, `darwinMessagesAnnotation`) is affected.
2. Reproduction steps — a minimal vitest-style snippet that reproduces the issue against the
   real `@langchain/langgraph` package is ideal. Redact secrets if any are involved.
3. Why you believe it is a security issue (auth bypass, secret leak, prototype pollution via
   nodeMap, memory leak that survives process restarts, etc.).
4. Whether you would like attribution in the fix commit.
5. Your preferred timeline for coordinated disclosure (default is 90 days, see below).

## Response timeline

We do not promise a 24-hour SLA. We are a small team. Realistic expectations:

- **Acknowledgement:** within 5 working days.
- **Initial assessment** (is this a security issue, what's the severity, what's the fix path):
  within 14 days of acknowledgement.
- **Patch landed for high-severity issues:** within 30 days of assessment, on a best-effort
  basis.
- **Lower-severity issues** ship in the next regular release.

If we go silent for more than 14 days without acknowledgement, please follow up — emails do get
lost.

## What counts as a security issue

Things we treat as security issues:

- **Prototype pollution via `nodeMap`.** A nodeMap entry value that mutates `Object.prototype`
  when normalised by the handler.
- **Secret leakage through OTEL attributes.** API keys, OAuth tokens, customer PII, or other
  secrets being written to span attributes by default (`opts.includeArguments` /
  `opts.includeResults` are opt-in by design — a regression here is a security issue).
- **Auth bypass through error swallowing.** A path where the adapter silently swallows an auth
  or permission failure from the underlying Darwin agent or LangGraph chain such that the
  consumer doesn't notice the failure.
- **Memory leaks that survive process restarts.** The `maxInFlightRuns` cap is the defence
  against unbounded growth of `runIdToName` — a bypass that lets the map grow without bound
  in production is a denial-of-service risk.
- **Determinism breaks in `withDarwinEvolution` that lose trajectories.** Concurrent invokes
  must each fire `onTrajectory` exactly once (the `Set<symbol>` race fix from R1 V0.1). A
  regression that re-introduces the double-fire or skip is a data-integrity issue.
- **Untrusted-input handling in user-supplied `onTrajectory`.** Even though the adapter swallows
  hook errors by design (fire-and-forget), a path where the swallow itself crashes the host
  graph is a security issue.
- **Dependency vulnerabilities** in transitively-pinned peer-deps that we ship in `devDependencies`
  (vitest, tsx, typescript) at HIGH or CRITICAL severity, if not already patched in the latest
  release.
- **Supply-chain attacks** — typosquatted package names, postinstall scripts (we have none —
  see "Defense-in-depth context" below), or compromised maintainer access.

Things that are **not** security issues but are still valid bug reports (open a normal `[bug]`
issue):

- Performance regressions.
- Best-practice suggestions ("you should warn earlier on streamMode='updates'").
- Anti-pattern corrections that don't involve data loss or unauthorized access.
- Documentation gaps or unclear README sections.
- A surface that doesn't work as documented in a non-security-relevant way.
- A surface that fails on a newer `@langchain/langgraph` SDK version because of API drift —
  upstream first.

## Coordinated disclosure

We ask reporters to wait for a fix before publishing details. The default disclosure window is
**90 days** from acknowledgement. If we have not landed a patch by then, you are free to
disclose publicly. We will not retaliate against good-faith researchers who follow this policy.

If the issue is being actively exploited in the wild, please tell us up front — we may release
a partial mitigation faster while a full fix is in progress.

## Defense-in-depth context

The adapter package surfaces the trace contract from `darwin-agents` to consumers of
`@langchain/langgraph`. Several layers each have their own security profile:

1. **Consumer code** (calls `graph.invoke(...)`, attaches `DarwinCallbackHandler`). The
   consumer is trusted to send a sane payload. State values are persisted to LangGraph's
   checkpointer if one is attached.
2. **Adapter surfaces** (`src/*`). No I/O outside of `console.warn` in error paths. No
   environment variable reads. No filesystem access. No outbound network. The adapter is a
   pure transformation layer. `DarwinCallbackHandler` keeps an in-memory `Map<runId, InFlightRun>`
   that is capped at 1024 entries by default (V0.3 hung-invoke guard).
3. **`darwin-agents` peer**. The adapter calls `runAgent(agent, task, opts)` and reads
   `result.experiment.trajectory`. Trajectory content is passed through verbatim — the adapter
   does not parse, validate, or modify trace fields beyond a shape-guard (`version === 1`,
   arrays for `toolCalls` + `errors`).
4. **`@langchain/langgraph` peer**. The adapter uses only public exports: `StateGraph`,
   `Annotation.Root`, `messagesStateReducer`, `isGraphInterrupt`. Internal LangGraph state is
   read via the documented callback contract (`metadata.langgraph_node`, `runId`, `parentRunId`).
5. **No build scripts.** The package has no `preinstall` / `install` / `postinstall` hooks.
   It does not execute code on `npm install`. `npm pack` produces `dist/` + 3 markdown files +
   `LICENSE`. Verify with `tar -tzf darwin-langgraph-X.Y.Z-alpha.N.tgz`.

If you find a security issue in **`darwin-agents` itself**, report it to the
[`darwin-agents` repo](https://github.com/studiomeyer-io/darwin-agents/security/policy) directly
with subject `[SECURITY] darwin-agents`. The adapter maintainer will be notified.

If you find a security issue in **`@langchain/langgraph` itself**, report it to the
[LangChain security team](https://github.com/langchain-ai/langgraphjs/security/policy)
directly. We will not relay third-party SDK reports.

If you find a security issue in **StudioMeyer Memory** (a downstream `darwin-agents` consumer,
not the adapter), report it to `matthias10121980meyer@gmail.com` with subject `[SECURITY] memory`.
