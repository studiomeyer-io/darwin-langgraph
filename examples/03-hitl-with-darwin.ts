/**
 * Example 3 — Human-in-the-Loop with a Darwin agent.
 *
 * LangGraph `interrupt()` pauses before the Darwin agent runs so a human
 * can approve or rewrite the task. After the agent finishes, the captured
 * trajectory is dispatched to the evolution hook for A/B telemetry.
 *
 * Run with:
 *   npm install darwin-langgraph@alpha @langchain/langgraph darwin-agents@alpha
 *   npx tsx examples/03-hitl-with-darwin.ts
 *
 * Pattern reference: see `agents/sma-langgraph.ts` in nex-hq for the
 * production HITL+Darwin combination.
 *
 * IMPORTANT (R1 Analyst Finding 7, S1185): this example uses
 * `MemorySaver` for the checkpointer, which lives in-process and is lost
 * on crash. For PRODUCTION HITL with durable resume across restarts,
 * use `@langchain/langgraph-checkpoint-postgres` (or another persistent
 * checkpointer) — `MemorySaver` is dev/example only.
 */

import {
  Command,
  interrupt,
  MemorySaver,
  StateGraph,
} from "@langchain/langgraph";
import { defineAgent } from "darwin-agents";

import {
  createDarwinNode,
  darwinAnnotation,
  withDarwinEvolution,
} from "../src/index.js";

interface ApprovalPayload {
  question: string;
  proposedTask: string;
}

async function main(): Promise<void> {
  const reviewer = defineAgent({
    name: "reviewer",
    role: "Customer Email Reviewer",
    description: "Reviews a draft customer email and suggests improvements.",
    systemPrompt:
      "You are a customer email reviewer. Return a 3-line markdown checklist: " +
      "tone OK / facts OK / call-to-action OK — each line ends with PASS or FAIL.",
  });

  const State = darwinAnnotation();

  function approvalNode(state: { task?: string }): Partial<{ task: string }> {
    const proposed = state.task ?? "";
    const revised = interrupt<ApprovalPayload, string>({
      question: "Approve this task for the Darwin reviewer? (return new text to override)",
      proposedTask: proposed,
    });
    return { task: revised };
  }

  const checkpointer = new MemorySaver();

  const graph = withDarwinEvolution(
    new StateGraph(State)
      .addNode("approval", approvalNode)
      .addNode("review", createDarwinNode(reviewer))
      .addEdge("__start__", "approval")
      .addEdge("approval", "review")
      .compile({ checkpointer }),
    {
      nodeMap: { review: "reviewer" },
      onTrajectory: (event) => {
        console.log(
          `[evolution-hook] ${event.nodeName} ran in ` +
            `${event.trajectory.turnCount} turns ` +
            `(${event.trajectory.toolCalls.length} tool calls).`,
        );
      },
    },
  );

  const threadId = `darwin-langgraph-example-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  // First call — hits the interrupt.
  console.log("=== First invoke (hits interrupt) ===");
  for await (const chunk of await graph.stream(
    { task: "Please review this draft email to a customer." },
    config,
  )) {
    console.log(chunk);
  }

  // Operator decides: approve as-is. Production code would surface the
  // interrupt payload to a human UI and resume with their answer.
  console.log();
  console.log("=== Resuming with operator approval ===");
  for await (const chunk of await graph.stream(
    new Command({ resume: "Please review this draft email to a customer." }),
    config,
  )) {
    console.log(chunk);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
