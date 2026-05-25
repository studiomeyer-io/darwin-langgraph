# Pull request

## What does this PR do?

One paragraph. New surface? Bug fix in an existing surface? Doc-only update? CI tweak?

## Which surface(s) does it touch?

- [ ] `createDarwinNode`
- [ ] `darwinAnnotation` / `getDarwinChannelSpec`
- [ ] `withDarwinEvolution` (@deprecated since V0.2 — fixes only, no feature work)
- [ ] `DarwinCallbackHandler`
- [ ] `toOtelAttributes` / `toolCallToOtelAttributes`
- [ ] `darwinMessagesAnnotation` / `getMessagesChannelSpec`
- [ ] Errors (`DarwinNodeError` / `DarwinEvolutionHookError`)
- [ ] Types (re-exports from `darwin-agents`)
- [ ] Package-wide (build, package.json, tsconfig, scripts)
- [ ] Docs (README, CHANGELOG, ECOSYSTEM, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT)
- [ ] CI (.github/workflows)

## Adapter compliance checklist

Confirm the change respects the conventions in CONTRIBUTING.md. If a box doesn't apply, mark it `n/a` in the description.

- [ ] **Zero hard runtime deps.** `npm ls --omit=dev --omit=peer` is empty after my change.
- [ ] **`npm test` is green.** All current tests pass with vitest `pool: forks`. Count after my change: `N/N green`.
- [ ] **`npm run typecheck` clean.** TypeScript strict mode. No new `any`, no new `@ts-expect-error` outside tests.
- [ ] **`npm run examples:check` clean.** `examples/` still type-checks.
- [ ] **`npm run build` clean.** `dist/` ships without errors.
- [ ] **`npm run verify:version-sync` clean.** `package.json#version` and `src/index.ts#VERSION` match.
- [ ] **New surface? Added a `tests/<name>.test.ts`** with happy path + error path + at least one edge case.
- [ ] **Touched a public surface? Updated README** with the new shape (consumer-facing migration if behaviour changed).
- [ ] **Touched a public surface? Updated CHANGELOG.md** under "Unreleased" with the right header (Added / Changed / Fixed / Removed / Security).
- [ ] **Touched a public surface? Updated `nex_decide` / `nex_learn`** in StudioMeyer Memory (for internal maintainers — public contributors can skip this).
- [ ] **Deprecation contract respected.** I have NOT removed `withDarwinEvolution` before v1.0.0, and I have NOT silenced its one-shot deprecation warning.
- [ ] **No real credentials, secrets, or API keys** committed.
- [ ] **No new postinstall / preinstall scripts** added (the package must be safe to `npm install`).

## Tests passing?

```bash
npm install && npm run typecheck && npm run examples:check && npm test && npm run build && npm run verify:version-sync
```

Paste the final line of the test run here (must show `N/N green`, no failures):

```
<paste output>
```

## Code-review trail (for internal maintainers)

For new public surfaces, both R1 and R2 of the agent-code-review skill must return GO before merge. Public contributors can skip this — a maintainer will run it before merging your PR.

- R1 report path: `<paste>` or `n/a`
- R2 report path: `<paste>` or `n/a`
- Findings count: `<R1 N findings / R2 N findings>` or `n/a`
- All MUST-FIX findings resolved in-place: yes / no

## Linked issue

Closes #
References #

## Conventional Commit subject

The PR's merged commit message should follow Conventional Commits. Pick one prefix:

- `feat(v0.X.Y-alpha.N): ...` — new feature aligned with the next version bump (e.g. `feat(v0.3.0-alpha.1): parent-run propagation`)
- `feat(<surface>): ...` — new feature in a specific surface (e.g. `feat(callback-handler): add maxInFlightRuns option`)
- `fix(<surface>): ...` — bug fix in a specific surface
- `docs(<area>): ...` — docs work (e.g. `docs(ecosystem): clarify Temporal pairing`)
- `chore(...)`, `refactor(...)`, `test(...)`, `ci(...)` — standard prefixes for the obvious cases

Paste your intended commit subject here so reviewers can confirm before merge:

```
<paste subject>
```
