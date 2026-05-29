/**
 * Surface 10 (V0.4) — `createTokenBudgetCallbacks(budget, onExceed)`.
 *
 * Production-pattern from the LangGraph TypeScript Production Guide
 * (langgraphjs.guide/production): a token budget enforced per-invocation
 * across ALL LLM calls inside a graph, throwing when the budget is
 * exceeded. Mirrors the canonical example with two differences:
 *
 *   1. Returned as a `BaseCallbackHandler` subclass so it composes with
 *      {@link DarwinCallbackHandler} via the standard `{ callbacks: [...] }`
 *      option — no model-side patching required, works against any
 *      LangChain provider that emits `handleLLMEnd`.
 *   2. Throws a typed {@link DarwinTokenBudgetExceededError} so consumers
 *      can `instanceof`-check without parsing message text.
 *
 * The handler tracks BOTH the LangChain-canonical `output.llmOutput.tokenUsage`
 * shape (used by `ChatOpenAI`, `ChatAnthropic`, etc.) AND the per-message
 * usage shape (`generations[0][0].message.usage_metadata`) some providers
 * emit. The total is monotonically non-decreasing across `handleLLMEnd`
 * events; once the budget is crossed the throw happens INSIDE
 * `handleLLMEnd`, which LangChain surfaces back to the caller of
 * `graph.invoke` / `graph.stream`.
 *
 * IMPORTANT: the throw is the only reliable abort signal — LangGraph's
 * node-level retry policy may still re-fire the budget-exceeded path.
 * The `onExceed` callback fires once per handler instance regardless of
 * how many times the throw is observed (use it for logging / alerting,
 * not retry).
 *
 * NEW V0.4 (S1235).
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

import { DarwinTokenBudgetExceededError } from "./errors.js";

/**
 * Options accepted by {@link createTokenBudgetCallbacks}.
 */
export interface TokenBudgetOptions {
  /**
   * Per-handler-instance token ceiling. Counts the SUM of input + output
   * tokens across every `handleLLMEnd` event. Must be a finite positive
   * integer; invalid values throw `DarwinTokenBudgetExceededError`
   * eagerly on construction so misconfigured deployments fail loud.
   */
  budget: number;
  /**
   * Fire-and-forget side-effect when the budget is exceeded. Receives the
   * cumulative total at the moment of breach, the configured budget, and
   * an optional `providerHint` extracted from the LLMResult (e.g. the
   * model name when emitted). Errors thrown inside this callback are
   * swallowed with a single warn so they cannot mask the budget throw.
   *
   * Use this for logging / metrics / alerting — not for retry.
   */
  onExceed?: (info: TokenBudgetExceedInfo) => void;
  /**
   * Fire on every `handleLLMEnd` event with the running total. Useful for
   * dashboards or step-by-step budget consumption traces. Optional.
   */
  onTick?: (info: TokenBudgetTickInfo) => void;
}

export interface TokenBudgetExceedInfo {
  budget: number;
  totalTokens: number;
  providerHint: string | undefined;
}

export interface TokenBudgetTickInfo {
  budget: number;
  totalTokens: number;
  deltaTokens: number;
  remainingTokens: number;
  providerHint: string | undefined;
}

/**
 * Internal helper — extract a usable token total from an LLMResult.
 * Prefers `output.llmOutput.tokenUsage.totalTokens` (LangChain canonical
 * for OpenAI + Anthropic) and falls back to summing the per-generation
 * `usage_metadata` (some providers).
 *
 * Returns 0 on a malformed shape rather than throwing — a token-budget
 * handler should never break the graph itself.
 */
function extractTokenDelta(output: LLMResult): number {
  // Canonical LangChain shape (ChatOpenAI / ChatAnthropic / etc.).
  const top = output as LLMResult & {
    llmOutput?: { tokenUsage?: { totalTokens?: unknown } };
  };
  const canonical = top.llmOutput?.tokenUsage?.totalTokens;
  if (typeof canonical === "number" && Number.isFinite(canonical) && canonical >= 0) {
    return canonical;
  }

  // Fallback: per-message `usage_metadata` (Anthropic native, some others).
  let summed = 0;
  if (output.generations && Array.isArray(output.generations)) {
    for (const generationGroup of output.generations) {
      if (!Array.isArray(generationGroup)) continue;
      for (const gen of generationGroup) {
        const m = (gen as { message?: { usage_metadata?: unknown } }).message;
        const usage = (m && (m as { usage_metadata?: unknown }).usage_metadata) as
          | { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }
          | undefined;
        if (!usage) continue;
        if (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)) {
          summed += usage.total_tokens;
        } else {
          const i =
            typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
              ? usage.input_tokens
              : 0;
          const o =
            typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)
              ? usage.output_tokens
              : 0;
          summed += i + o;
        }
      }
    }
  }
  return summed;
}

function extractProviderHint(output: LLMResult): string | undefined {
  const top = output as LLMResult & {
    llmOutput?: { modelName?: unknown; model_name?: unknown };
  };
  const a = top.llmOutput?.modelName;
  if (typeof a === "string" && a.length > 0) return a;
  const b = top.llmOutput?.model_name;
  if (typeof b === "string" && b.length > 0) return b;
  return undefined;
}

/**
 * LangChain `BaseCallbackHandler` that enforces a hard token budget
 * across all LLM calls observed during its lifetime.
 *
 * Construct once per `graph.invoke` call (do NOT reuse across requests —
 * the running total is per-handler-instance). The
 * {@link createTokenBudgetCallbacks} factory makes the per-invocation
 * shape ergonomic.
 */
export class TokenBudgetCallbackHandler extends BaseCallbackHandler {
  public override readonly name = "DarwinTokenBudgetHandler";
  /**
   * V0.4 R1 P2-3 fix (S1235): `awaitHandlers = true` is required so
   * LangChain's callback manager AWAITS this handler before continuing
   * — the synchronous `throw` from `handleLLMEnd` MUST reach the
   * `graph.invoke` caller. With `awaitHandlers = false` the throw may
   * surface as an unhandled rejection in some LangChain versions
   * rather than aborting the graph, which is the entire point of a
   * token budget.
   */
  public override readonly awaitHandlers = true;

  private readonly budget: number;
  private readonly onExceed: TokenBudgetOptions["onExceed"];
  private readonly onTick: TokenBudgetOptions["onTick"];
  private totalTokens = 0;
  private exceedWarned = false;
  private exceedFired = false;
  private tickErrorWarned = false;

  constructor(opts: TokenBudgetOptions) {
    super();
    if (
      typeof opts?.budget !== "number" ||
      !Number.isFinite(opts.budget) ||
      opts.budget <= 0 ||
      !Number.isInteger(opts.budget)
    ) {
      // R1-self-check: misconfigured budget is a deploy bug, not a
      // runtime hiccup — fail loud on construction so it surfaces in
      // CI / dev rather than at the first LLM call in prod.
      throw new DarwinTokenBudgetExceededError(
        `createTokenBudgetCallbacks: budget must be a finite positive integer, got ${String(
          opts?.budget,
        )}.`,
        typeof opts?.budget === "number" ? opts.budget : 0,
        0,
        undefined,
      );
    }
    this.budget = opts.budget;
    this.onExceed = opts.onExceed;
    this.onTick = opts.onTick;
  }

  override handleLLMEnd(output: LLMResult): void {
    const delta = extractTokenDelta(output);
    const providerHint = extractProviderHint(output);
    // Tick logic — fire even when delta is 0 so dashboards see steady
    // ticks (helpful for "is the agent stuck?" detection).
    this.totalTokens += delta;
    const remaining = Math.max(0, this.budget - this.totalTokens);
    if (this.onTick) {
      try {
        this.onTick({
          budget: this.budget,
          totalTokens: this.totalTokens,
          deltaTokens: delta,
          remainingTokens: remaining,
          providerHint,
        });
      } catch (err) {
        this.warnTick(err);
      }
    }

    if (this.totalTokens > this.budget) {
      if (this.onExceed && !this.exceedFired) {
        this.exceedFired = true;
        try {
          this.onExceed({
            budget: this.budget,
            totalTokens: this.totalTokens,
            providerHint,
          });
        } catch (err) {
          if (!this.exceedWarned) {
            this.exceedWarned = true;
            console.warn(
              `[darwin-langgraph] TokenBudgetCallbackHandler.onExceed threw — ` +
                `swallowed to keep the budget throw visible. Subsequent throws ` +
                `from onExceed are silent. Original error: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      throw new DarwinTokenBudgetExceededError(
        `Token budget exceeded: ${this.totalTokens}/${this.budget} ` +
          `(provider: ${providerHint ?? "unknown"}).`,
        this.budget,
        this.totalTokens,
        providerHint,
      );
    }
  }

  private warnTick(err: unknown): void {
    if (this.tickErrorWarned) return;
    this.tickErrorWarned = true;
    console.warn(
      `[darwin-langgraph] TokenBudgetCallbackHandler.onTick threw — swallowed. ` +
        `Subsequent throws from onTick are silent. Original error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /** Helper for tests + debug introspection. */
  public getTotalTokens(): number {
    return this.totalTokens;
  }
}

/**
 * Factory that returns a single-element `BaseCallbackHandler[]` ready to
 * be passed via the standard LangGraph `{ callbacks: [...] }` option.
 * Returning an array is the ergonomic shape — most consumers spread it
 * into a larger callbacks array next to {@link DarwinCallbackHandler}.
 *
 * @example
 * ```ts
 * import {
 *   DarwinCallbackHandler,
 *   createTokenBudgetCallbacks,
 *   DarwinTokenBudgetExceededError,
 * } from "darwin-langgraph";
 *
 * try {
 *   const result = await graph.invoke({ task: "..." }, {
 *     callbacks: [
 *       new DarwinCallbackHandler({ nodeMap, onTrajectory }),
 *       ...createTokenBudgetCallbacks({
 *         budget: 20_000,
 *         onExceed: ({ totalTokens, providerHint }) => {
 *           console.error(`Budget breach: ${totalTokens} tok (${providerHint})`);
 *         },
 *       }),
 *     ],
 *   });
 * } catch (err) {
 *   if (err instanceof DarwinTokenBudgetExceededError) {
 *     // ... graceful degradation, fallback model, etc.
 *   }
 * }
 * ```
 */
export function createTokenBudgetCallbacks(
  opts: TokenBudgetOptions,
): [TokenBudgetCallbackHandler] {
  return [new TokenBudgetCallbackHandler(opts)];
}
