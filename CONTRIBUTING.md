# Contributing

Thanks for considering a contribution. This repo ships an **adapter package** that bridges
[`darwin-agents`](https://github.com/studiomeyer-io/darwin-agents) (self-evolving AI agents)
and [`@langchain/langgraph`](https://github.com/langchain-ai/langgraphjs) (state-graph workflow
orchestration). Both upstream packages are declared as `peerDependencies` — the adapter ships
zero hard runtime deps. Every change here represents the bridge layer in front of developers
evaluating Darwin as a LangGraph-native agent framework, so the bar is high.

## What we accept

A change is a strong candidate when it:

- Adds a small, focused surface (a new helper, a new annotation variant, a new callback option)
  that integrates Darwin's existing functionality with a LangGraph-native pattern.
- Has tests using vitest with the `@langchain/langgraph` package as a real dependency (no mocking
  of LangGraph internals — we exercise the public callback contract end-to-end).
- Keeps the package zero-hard-deps. Anything new that requires a peer is a discussion before
  the PR.
- Follows the canonical layout (see "Folder layout" below).
- Updates `CHANGELOG.md` and bumps `VERSION` in both `package.json` and `src/index.ts` via the
  `verify:version-sync` script.

A change is **not** a good fit when it:

- Adds a hard runtime dependency. The whole point of an adapter is that consumers control the
  upstream version.
- Replicates Darwin or LangGraph functionality that should live in one of the upstream packages.
- Breaks the deprecation contract on `withDarwinEvolution` (it warns on every first call until
  v1.0.0 — do not silently remove the warning, do not remove the function before v1.0.0).
- Couples the adapter to a private LangGraph internal that isn't part of the documented public
  API. We import `isGraphInterrupt` and `BaseCallbackHandler` from public entry points only.
- Drops test coverage for `withDarwinEvolution` (legacy surface). Even though it's deprecated,
  we maintain its tests until it's removed.

## Folder layout

The repo is a single-package npm module — there are no workspaces.

```
darwin-langgraph/
├── package.json             # peerDependencies, scripts, dist-tags
├── tsconfig.json            # strict mode, ESM, dist output
├── tsconfig.examples.json   # extends tsconfig for examples/ type-check
├── vitest.config.ts         # ESM, no globals, single-fork pool
├── README.md                # consumer-facing intro + V0.1 → V0.2 → V0.3 migration
├── CHANGELOG.md             # release log (semver alpha)
├── ECOSYSTEM.md             # pairing notes + sibling-repo positioning
├── SECURITY.md              # disclosure policy + supply-chain stance
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md          # this file
├── LICENSE                  # MIT
├── src/
│   ├── index.ts             # PUBLIC entry — exports + VERSION
│   ├── types.ts             # re-exports from darwin-agents
│   ├── errors.ts            # DarwinNodeError + DarwinEvolutionHookError
│   ├── create-darwin-node.ts        # surface 1 (V0.1)
│   ├── darwin-annotation.ts         # surface 2 (V0.1)
│   ├── with-darwin-evolution.ts     # surface 3 (V0.1, @deprecated since V0.2)
│   ├── darwin-callback-handler.ts   # surface 4 (V0.2 — preferred)
│   ├── to-otel-attributes.ts        # surface 5 (V0.2)
│   └── darwin-messages-annotation.ts # surface 6 (V0.2)
├── tests/                   # vitest — one *.test.ts per surface + R1/R2/V0.3 regression files
└── examples/                # type-checkable consumer examples (no runtime exec)
```

New surfaces go in their own `src/<surface-name>.ts` file with a matching
`tests/<surface-name>.test.ts`. Cross-surface regression tests live in `tests/r1-fixes.test.ts`,
`tests/r2-v02-fixes.test.ts`, `tests/v03-features.test.ts` and so on — number-suffixed by the
review round that exposed the bug.

## Using the `agent-code-review` skill

If you work inside Claude Code, the global skill `agent-code-review` runs a 3-agent loop
(Critic + Analyst + Research) in parallel on the changed paths and synthesizes findings into
must-fix / nice-to-have / context. We run R1 before publish and R2 after the R1 fixes land, and
both rounds must return GO before a tag goes out. The skill writes reports to
`/home/simple/nex-hq/research/{date}-{tag}-{agent}.md`.

Outside Claude Code: open a draft PR, ask three independent reviewers to look at it
specifically for (a) bugs / security, (b) architecture / API ergonomics, (c) ecosystem fit
against current LangGraph + LangChain docs. We don't merge without three sets of eyes for any
new public surface.

## Code-review expectations

Every PR must pass:

1. **Zero hard runtime deps.** `npm ls --omit=dev --omit=peer` must be empty. The whole package
   ships only `dist/` + `README` + `CHANGELOG` + `LICENSE`. New `dependencies` entries require
   a written reason in the PR body.
2. **`npm test` is green.** All current tests (132/132 as of v0.3.0-alpha.1) pass with vitest
   `pool: forks`. New surfaces add a `tests/<name>.test.ts` with at minimum: happy path, error
   path, and one edge case (concurrent invoke, falsy input, large fan-out — whichever applies).
3. **`npm run typecheck` clean.** TypeScript strict mode. No `any`, no `@ts-expect-error` outside
   tests, no `as unknown as X` outside tests. `examples/` also type-checks via
   `npm run examples:check`.
4. **`npm run build` clean.** The `dist/` output ships ESM with declaration files. Manual
   inspection of `dist/index.d.ts` to confirm the public types are stable across the bump.
5. **`npm run verify:version-sync` clean.** `package.json#version` and `src/index.ts#VERSION`
   stay in lockstep — the `prepublishOnly` hook blocks publish on drift.
6. **CHANGELOG entry under the right header.** New features → "Added". Behaviour changes → "Changed".
   Removed surfaces → "Removed" (but only between major bumps). Security fixes → "Security".
   Keep an "Unreleased" section at the top while a PR is in flight.

## PR format

We use Conventional Commits. Look at recent history (`git log --oneline`) for the exact style — examples:

- `feat(v0.3.0-alpha.1): parent-run propagation + double-wrap warn + hung-invoke guard`
- `fix(callback-handler): swallow falsy errors from onTrajectory`
- `docs(otel): clarify cache_read.input_tokens vs cache_creation`
- `chore: bump @langchain/langgraph dev-dep to 1.3.2`

Other rules:

- **One surface per PR.** Don't combine the OTEL helper and the MessagesAnnotation in the same
  change.
- **Branch name:** `feature/<surface-name>` for new surfaces, `fix/<short-description>` for
  bugs, `docs/<area>` for docs-only.
- **PR description** must contain: what changed, why, which surfaces touched, the test counts
  before/after, and a checklist of the 6 review criteria above.
- **Squash-merge to `main`.** Feature branches don't accumulate merge commits.

## Branch strategy

- `main` is always green and reflects the latest tagged release plus any in-flight unreleased
  work that has passed review.
- Feature work lives on `feature/<surface>` or `fix/<short>` branches off `main`.
- PRs require at least one maintainer review before squash-merge.
- Tags follow semver with `-alpha.N` suffix while the API is settling, `-beta.N` when we're
  feature-complete for a minor, no suffix when frozen.

## Local development

```bash
# 1. Clone + install (peer-deps are required for dev)
git clone https://github.com/studiomeyer-io/darwin-langgraph
cd darwin-langgraph
npm install

# 2. Run the full quality gate
npm run typecheck          # strict TS, src + tests
npm run examples:check     # strict TS, examples only
npm test                   # vitest run, 132/132 expected green as of v0.3.0-alpha.1
npm run build              # tsc → dist/
npm run verify:version-sync # package.json#version === src/index.ts#VERSION
```

The adapter does not require any running services. All tests use vitest with the real
`@langchain/langgraph` package; `darwin-agents` is mocked at the `runAgent` boundary via
`vi.mock("darwin-agents", ...)` so no API key is needed.

## How to report bugs

Open a GitHub issue with the `bug` label. Include:

- Which surface is affected (`createDarwinNode` / `darwinAnnotation` / `withDarwinEvolution` /
  `DarwinCallbackHandler` / `toOtelAttributes` / `darwinMessagesAnnotation`).
- Adapter version (`darwin-langgraph@X.Y.Z-alpha.N`) and peer versions (`darwin-agents`,
  `@langchain/langgraph`).
- Node.js version (`node --version`) and OS.
- Minimal repro: a `tests/` style snippet that reproduces the failure without external
  services. We mock `runAgent` and use real LangGraph internals.
- What you expected vs what happened.

Security bugs go to `matthias10121980meyer@gmail.com` with subject `[SECURITY] darwin-langgraph`.
See [SECURITY.md](./SECURITY.md) for details.

## How to request features

Open a GitHub issue with the `enhancement` label. We're especially interested in:

- **New LangGraph integration patterns** that aren't yet wrapped — e.g. `Send` API support for
  fan-out fan-in, `Command` API for state updates from inside a node, checkpointer-aware
  trajectory replay.
- **Adjacent ecosystem hookups** — OTEL exporter bindings, Langfuse handler subclass,
  LangSmith trace correlation, Temporal Cloud activity-level trajectory replay.
- **DX improvements** — better error messages, better TypeScript inference, JSDoc clarifications.

Feature requests should explain the **problem** first, not the proposed solution.
"We need to correlate Darwin trajectories with our Langfuse traces because X" beats
"please add `langfuseHandler` to V0.4".

## Adapter package vs upstream packages

The adapter package's job is **strictly translation** — wrapping Darwin's existing functionality
in LangGraph-native patterns and exposing Darwin's trace surface in formats that downstream
consumers (OTEL, Langfuse, LangSmith) expect.

- **Darwin-side bugs** (e.g. wrong `ExecutionTrace` content) belong in
  [`darwin-agents`](https://github.com/studiomeyer-io/darwin-agents). The adapter passes the
  trace through unchanged.
- **LangGraph-side bugs** (e.g. callback contract changes) belong in
  [`@langchain/langgraph`](https://github.com/langchain-ai/langgraphjs). The adapter pins
  ranges and warns on incompatibility.
- **Adapter-side bugs** are anything in our `src/` — bridging logic, error wrapping, OTEL
  mapping, deprecation warnings, double-wrap detection, in-flight cleanup.

If a fix needs to land in two places to fully resolve, the PR description must call that out
and link the upstream PR.

## Tone

Be direct. Be technical. Be helpful. Disagree on substance, not on people. The full Code of
Conduct lives in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see
[LICENSE](./LICENSE)).
