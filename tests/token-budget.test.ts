/**
 * V0.4 regression tests — `createTokenBudgetCallbacks` /
 * `TokenBudgetCallbackHandler` / `DarwinTokenBudgetExceededError`.
 *
 * Coverage:
 *   - construction-time validation (NaN / Infinity / 0 / negative / non-integer)
 *   - extractTokenDelta both canonical + per-message paths
 *   - throw on budget breach with typed error + exposed fields
 *   - onExceed / onTick fire + swallow errors
 *   - providerHint extraction (modelName / model_name)
 *   - factory shape
 */

import type { LLMResult } from "@langchain/core/outputs";
import { describe, expect, it, vi } from "vitest";

import {
  TokenBudgetCallbackHandler,
  createTokenBudgetCallbacks,
} from "../src/token-budget.js";
import { DarwinTokenBudgetExceededError } from "../src/errors.js";

function llmResult(opts: {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  modelName?: string;
  model_name?: string;
  useUsageMetadata?: boolean;
}): LLMResult {
  const llmOutput: Record<string, unknown> = {};
  if (opts.totalTokens !== undefined) {
    llmOutput["tokenUsage"] = { totalTokens: opts.totalTokens };
  }
  if (opts.modelName !== undefined) llmOutput["modelName"] = opts.modelName;
  if (opts.model_name !== undefined) llmOutput["model_name"] = opts.model_name;
  const generations: unknown[][] = opts.useUsageMetadata
    ? [
        [
          {
            text: "x",
            message: {
              usage_metadata: {
                input_tokens: opts.inputTokens ?? 0,
                output_tokens: opts.outputTokens ?? 0,
              },
            },
          },
        ],
      ]
    : [[{ text: "x" }]];
  return {
    generations: generations as never,
    llmOutput,
  };
}

describe("TokenBudgetCallbackHandler — construction", () => {
  it("throws DarwinTokenBudgetExceededError on NaN budget", () => {
    expect(() => new TokenBudgetCallbackHandler({ budget: NaN })).toThrow(
      DarwinTokenBudgetExceededError,
    );
  });

  it("throws DarwinTokenBudgetExceededError on Infinity budget", () => {
    expect(
      () => new TokenBudgetCallbackHandler({ budget: Infinity }),
    ).toThrow(DarwinTokenBudgetExceededError);
  });

  it("throws on 0 budget", () => {
    expect(() => new TokenBudgetCallbackHandler({ budget: 0 })).toThrow(
      DarwinTokenBudgetExceededError,
    );
  });

  it("throws on negative budget", () => {
    expect(() => new TokenBudgetCallbackHandler({ budget: -100 })).toThrow(
      DarwinTokenBudgetExceededError,
    );
  });

  it("throws on non-integer budget", () => {
    expect(
      () => new TokenBudgetCallbackHandler({ budget: 1000.5 }),
    ).toThrow(DarwinTokenBudgetExceededError);
  });

  it("accepts positive integer budget", () => {
    expect(() => new TokenBudgetCallbackHandler({ budget: 1000 })).not.toThrow();
  });
});

describe("TokenBudgetCallbackHandler — extractTokenDelta", () => {
  it("reads canonical llmOutput.tokenUsage.totalTokens", () => {
    const handler = new TokenBudgetCallbackHandler({ budget: 10_000 });
    handler.handleLLMEnd(llmResult({ totalTokens: 250 }));
    expect(handler.getTotalTokens()).toBe(250);
  });

  it("falls back to summing per-message usage_metadata", () => {
    const handler = new TokenBudgetCallbackHandler({ budget: 10_000 });
    handler.handleLLMEnd(
      llmResult({
        useUsageMetadata: true,
        inputTokens: 100,
        outputTokens: 50,
      }),
    );
    expect(handler.getTotalTokens()).toBe(150);
  });

  it("yields 0 delta on malformed shape", () => {
    const handler = new TokenBudgetCallbackHandler({ budget: 10_000 });
    handler.handleLLMEnd({ generations: [] } as unknown as LLMResult);
    expect(handler.getTotalTokens()).toBe(0);
  });

  it("accumulates across multiple LLM calls", () => {
    const handler = new TokenBudgetCallbackHandler({ budget: 10_000 });
    handler.handleLLMEnd(llmResult({ totalTokens: 100 }));
    handler.handleLLMEnd(llmResult({ totalTokens: 200 }));
    handler.handleLLMEnd(llmResult({ totalTokens: 300 }));
    expect(handler.getTotalTokens()).toBe(600);
  });
});

describe("TokenBudgetCallbackHandler — budget enforcement", () => {
  it("throws DarwinTokenBudgetExceededError on breach", () => {
    const handler = new TokenBudgetCallbackHandler({ budget: 500 });
    expect(() =>
      handler.handleLLMEnd(llmResult({ totalTokens: 600 })),
    ).toThrow(DarwinTokenBudgetExceededError);
  });

  it("exposes budget + totalTokens + providerHint on the typed error", () => {
    const handler = new TokenBudgetCallbackHandler({ budget: 500 });
    try {
      handler.handleLLMEnd(
        llmResult({ totalTokens: 750, modelName: "claude-haiku-4-5" }),
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DarwinTokenBudgetExceededError);
      const tx = err as DarwinTokenBudgetExceededError;
      expect(tx.budget).toBe(500);
      expect(tx.totalTokens).toBe(750);
      expect(tx.providerHint).toBe("claude-haiku-4-5");
    }
  });

  it("fires onExceed exactly once across multiple breach calls", () => {
    const onExceed = vi.fn();
    const handler = new TokenBudgetCallbackHandler({
      budget: 500,
      onExceed,
    });
    try {
      handler.handleLLMEnd(llmResult({ totalTokens: 600 }));
    } catch {
      /* swallow */
    }
    try {
      handler.handleLLMEnd(llmResult({ totalTokens: 700 }));
    } catch {
      /* swallow */
    }
    expect(onExceed).toHaveBeenCalledTimes(1);
  });

  it("fires onTick with delta + remaining on every LLM end", () => {
    const onTick = vi.fn();
    const handler = new TokenBudgetCallbackHandler({
      budget: 1000,
      onTick,
    });
    handler.handleLLMEnd(llmResult({ totalTokens: 200 }));
    handler.handleLLMEnd(llmResult({ totalTokens: 100 }));
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(onTick.mock.calls[0][0]).toMatchObject({
      budget: 1000,
      totalTokens: 200,
      deltaTokens: 200,
      remainingTokens: 800,
    });
    expect(onTick.mock.calls[1][0]).toMatchObject({
      budget: 1000,
      totalTokens: 300,
      deltaTokens: 100,
      remainingTokens: 700,
    });
  });

  it("onTick errors are swallowed with one-shot warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = new TokenBudgetCallbackHandler({
      budget: 1000,
      onTick: () => {
        throw new Error("tick boom");
      },
    });
    handler.handleLLMEnd(llmResult({ totalTokens: 100 }));
    handler.handleLLMEnd(llmResult({ totalTokens: 50 }));
    const tickWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("TokenBudgetCallbackHandler.onTick"),
    );
    expect(tickWarns.length).toBe(1);
  });

  it("onExceed errors are swallowed with one-shot warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = new TokenBudgetCallbackHandler({
      budget: 100,
      onExceed: () => {
        throw new Error("exceed boom");
      },
    });
    try {
      handler.handleLLMEnd(llmResult({ totalTokens: 200 }));
    } catch {
      /* swallow */
    }
    const exceedWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("TokenBudgetCallbackHandler.onExceed"),
    );
    expect(exceedWarns.length).toBe(1);
  });
});

describe("TokenBudgetCallbackHandler — providerHint extraction", () => {
  it("extracts modelName (camelCase, LangChain canonical)", () => {
    const onExceed = vi.fn();
    const handler = new TokenBudgetCallbackHandler({
      budget: 100,
      onExceed,
    });
    try {
      handler.handleLLMEnd(
        llmResult({ totalTokens: 200, modelName: "gpt-4o" }),
      );
    } catch {
      /* swallow */
    }
    expect(onExceed.mock.calls[0][0].providerHint).toBe("gpt-4o");
  });

  it("falls back to model_name (snake_case, some providers)", () => {
    const onExceed = vi.fn();
    const handler = new TokenBudgetCallbackHandler({
      budget: 100,
      onExceed,
    });
    try {
      handler.handleLLMEnd(
        llmResult({ totalTokens: 200, model_name: "qwen-2.5" }),
      );
    } catch {
      /* swallow */
    }
    expect(onExceed.mock.calls[0][0].providerHint).toBe("qwen-2.5");
  });

  it("providerHint undefined when neither is present", () => {
    const onExceed = vi.fn();
    const handler = new TokenBudgetCallbackHandler({
      budget: 100,
      onExceed,
    });
    try {
      handler.handleLLMEnd(llmResult({ totalTokens: 200 }));
    } catch {
      /* swallow */
    }
    expect(onExceed.mock.calls[0][0].providerHint).toBeUndefined();
  });
});

describe("createTokenBudgetCallbacks — factory shape", () => {
  it("returns single-element array", () => {
    const arr = createTokenBudgetCallbacks({ budget: 1000 });
    expect(arr).toHaveLength(1);
    expect(arr[0]).toBeInstanceOf(TokenBudgetCallbackHandler);
  });

  it("spreadable into callbacks array next to other handlers", () => {
    const arr = createTokenBudgetCallbacks({ budget: 1000 });
    const combined = ["a", ...arr, "b"];
    expect(combined.length).toBe(3);
    expect(combined[1]).toBeInstanceOf(TokenBudgetCallbackHandler);
  });
});
