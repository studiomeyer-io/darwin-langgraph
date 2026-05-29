/**
 * Example 4 — OTEL + W3C Trace Context + token budget enforcement.
 *
 * Wires together the V0.4 surfaces:
 *   - `DarwinCallbackHandler` with `onTrajectory` + `onToolEvent`
 *   - `toOtelAttributes(event, { langGraphNode, userId, requestId })`
 *   - `toolCallToOtelAttributes` per tool call
 *   - `toW3CTraceContext(event)` → `traceparent` header for Langfuse / OTLP / Datadog
 *   - `createTokenBudgetCallbacks(...)` to abort runaway agents
 *
 * The example uses console-only "exporters" so it runs without external
 * services. Replace `emitSpan` with your real OTLP exporter
 * (`@opentelemetry/exporter-trace-otlp-http`, Langfuse JS SDK, etc.).
 *
 * Run with:
 *   npm install darwin-langgraph@alpha @langchain/langgraph darwin-agents@alpha
 *   npx tsx examples/04-otel-and-budget.ts
 *
 * NEW V0.4 (S1235).
 */

import { StateGraph } from "@langchain/langgraph";
import { defineAgent } from "darwin-agents";

import {
  createDarwinNode,
  darwinAnnotation,
  DarwinCallbackHandler,
  DarwinTokenBudgetExceededError,
  createTokenBudgetCallbacks,
  toOtelAttributes,
  toolCallToOtelAttributes,
  toW3CTraceContext,
  type DarwinTrajectoryEvent,
  type DarwinToolEvent,
} from "../src/index.js";

/**
 * Stand-in for a real OTEL span emitter / Langfuse SDK call.
 * Replace this with `tracer.startActiveSpan(...)` + `span.setAttributes(...)`
 * once you wire a real exporter — the attribute shape is already
 * exporter-compatible.
 */
function emitSpan(
  name: string,
  attributes: Record<string, unknown>,
  context?: { traceparent: string },
): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ span: name, attributes, context }));
}

async function main(): Promise<void> {
  const summarizer = defineAgent({
    name: "summarizer",
    role: "Text Summarizer",
    description: "Summarizes any text into 3 bullets.",
    systemPrompt: "Return exactly 3 bullet points.",
    maxTurns: 2,
  });

  const handler = new DarwinCallbackHandler({
    nodeMap: { summarize: "summarizer" },
    onTrajectory: (event: DarwinTrajectoryEvent) => {
      // Build the OTEL attribute bag for the agent span.
      const attrs = toOtelAttributes(event.trajectory, {
        agentName: event.agentName,
        agentId: event.runId,
        langGraphNode: event.nodeName,
        // Carry the end-user id you authenticated upstream — useful for
        // per-user cost dashboards in Langfuse / Honeycomb.
        userId: "user-42",
        requestId: "req-2026-05-29-001",
      });

      // Use W3C traceparent so a downstream Langfuse / OTLP collector
      // attaches this span to the same trace as the HTTP request that
      // kicked off `graph.invoke()`.
      const ctx = toW3CTraceContext(event);
      emitSpan(
        "darwin.agent.invoke",
        attrs,
        ctx ? { traceparent: ctx.traceparent } : undefined,
      );

      // Per-tool spans. Each tool call becomes a child span of the agent
      // span via `parent-id = span-id` and inherits the same trace.
      for (const call of event.trajectory.toolCalls) {
        emitSpan("darwin.tool.execute", toolCallToOtelAttributes(call, {
          includeArguments: false, // opt-in flip when you trust the data
          includeResults: false,
        }), ctx ? { traceparent: ctx.traceparent } : undefined);
      }
    },
    onToolEvent: (event: DarwinToolEvent) => {
      // Tool start / end / error events — emit progress span markers so
      // the Langfuse UI shows live tool execution before the agent
      // trajectory is finalised.
      emitSpan(`darwin.tool.${event.phase}`, {
        "gen_ai.tool.name": event.toolName,
        "gen_ai.langgraph.node": event.nodeName,
        "darwin.agent.name": event.agentName,
      });
    },
  });

  const State = darwinAnnotation();
  const graph = new StateGraph(State)
    .addNode("summarize", createDarwinNode(summarizer, {
      onAttempt: (info) => {
        // If LangGraph retried, log it so the budget dashboard accounts
        // for cumulative cost across attempts.
        if (info.nodeAttempt > 1) {
          // eslint-disable-next-line no-console
          console.warn(
            `[summarize] retry attempt ${info.nodeAttempt} ` +
              `(step=${info.langGraphStep})`,
          );
        }
      },
    }))
    .addEdge("__start__", "summarize")
    .compile();

  // 20k tokens is generous for a single summary — the throw should NOT
  // fire under normal operation. Lower this in production tests to make
  // sure your fallback path works.
  const budgetCallbacks = createTokenBudgetCallbacks({
    budget: 20_000,
    onExceed: ({ totalTokens, providerHint }) => {
      // eslint-disable-next-line no-console
      console.error(
        `[budget] cost ceiling breached: ${totalTokens} tok ` +
          `(provider: ${providerHint ?? "?"})`,
      );
    },
    onTick: ({ totalTokens, remainingTokens }) => {
      // eslint-disable-next-line no-console
      console.log(`[budget] used=${totalTokens} remaining=${remainingTokens}`);
    },
  });

  try {
    const result = await graph.invoke(
      { task: "Summarise the GEPA Stanford 2024 paper in 3 bullets." },
      { callbacks: [handler, ...budgetCallbacks] },
    );
    // eslint-disable-next-line no-console
    console.log("=== Summary ===");
    // eslint-disable-next-line no-console
    console.log(result.output);
  } catch (err) {
    if (err instanceof DarwinTokenBudgetExceededError) {
      // eslint-disable-next-line no-console
      console.error(
        `Aborting — token budget exceeded ` +
          `(${err.totalTokens}/${err.budget}). Falling back to cached response.`,
      );
      // Real apps: serve a cached / static fallback here.
      return;
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
