/**
 * Public-surface guard.
 *
 * `darwin-langgraph`'s entire contract is its stable barrel export: a fixed
 * set of runtime surfaces + re-exported `darwin-agents` types. The README
 * advertises "11 surfaces" and the package is additive-only across versions.
 * A typo, an accidental rename, or a dropped re-export (e.g. the V0.5.2
 * `LLMProvider` addition) would silently break consumers without failing any
 * behavioural test. This file pins the runtime barrel so such a regression
 * fails CI instead.
 *
 * Type-only re-exports (`AgentDefinition`, `ExecutionTrace`, `LLMProvider`,
 * …) are erased at runtime and cannot be asserted with `typeof`; the
 * `examples:check` + `typecheck` gates cover those by compiling the
 * single-import pattern. Here we guard the value exports.
 */
import { describe, expect, it } from "vitest";

import * as api from "../src/index.js";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string };

describe("public surface — runtime value exports", () => {
  // Every key here must be a runtime export of the barrel. Grouped to
  // mirror the README "Surfaces" table.
  const expected: Record<string, "function"> = {
    // Surface 1 + helpers
    createDarwinNode: "function",
    // Surface 2 + power-user escape hatches
    darwinAnnotation: "function",
    getDarwinChannelSpec: "function",
    lastWriteWinsTrajectoryReducer: "function",
    // Surface 3 (deprecated, still exported until v1.0)
    withDarwinEvolution: "function",
    // Surface 4
    DarwinCallbackHandler: "function",
    // Surface 5
    toOtelAttributes: "function",
    toolCallToOtelAttributes: "function",
    // Surface 6
    darwinMessagesAnnotation: "function",
    getMessagesChannelSpec: "function",
    // Surface 7
    darwinAccumulatingAnnotation: "function",
    getDarwinAccumulatingChannelSpec: "function",
    darwinTrajectoryAccumulatorReducer: "function",
    // Surface 8
    TokenBudgetCallbackHandler: "function",
    createTokenBudgetCallbacks: "function",
    // Surface 9
    toW3CTraceContext: "function",
    // Surface 11 — error classes (constructable functions)
    DarwinNodeError: "function",
    DarwinEvolutionHookError: "function",
    DarwinTokenBudgetExceededError: "function",
  };

  for (const [name, kind] of Object.entries(expected)) {
    it(`exports ${name} as a ${kind}`, () => {
      expect(typeof (api as Record<string, unknown>)[name]).toBe(kind);
    });
  }

  it("exports MAX_KNOWN_TRACE_VERSION as a positive integer constant", () => {
    expect(typeof api.MAX_KNOWN_TRACE_VERSION).toBe("number");
    expect(Number.isInteger(api.MAX_KNOWN_TRACE_VERSION)).toBe(true);
    expect(api.MAX_KNOWN_TRACE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("does not regress the documented surface count (>= 11 callable surfaces)", () => {
    const callableSurfaces = Object.entries(api).filter(
      ([, v]) => typeof v === "function",
    );
    // 11 documented surfaces expand to more runtime callables (helpers +
    // error classes). Guard the floor so a deletion is caught.
    expect(callableSurfaces.length).toBeGreaterThanOrEqual(11);
  });
});

describe("public surface — VERSION", () => {
  it("the exported VERSION matches package.json exactly", () => {
    expect(api.VERSION).toBe(pkg.version);
  });
});

describe("public surface — error classes are real Error subclasses", () => {
  it("DarwinNodeError carries agentName + cause and is instanceof Error", () => {
    const cause = new Error("upstream");
    const err = new api.DarwinNodeError("boom", "researcher", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DarwinNodeError");
    expect(err.agentName).toBe("researcher");
    expect(err.cause).toBe(cause);
  });

  it("DarwinTokenBudgetExceededError carries budget + totalTokens + providerHint", () => {
    const err = new api.DarwinTokenBudgetExceededError(
      "over budget",
      1000,
      1500,
      "claude-haiku-4-5",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DarwinTokenBudgetExceededError");
    expect(err.budget).toBe(1000);
    expect(err.totalTokens).toBe(1500);
    expect(err.providerHint).toBe("claude-haiku-4-5");
  });
});
