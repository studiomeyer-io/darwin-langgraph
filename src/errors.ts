/**
 * Adapter-specific error classes. Both subclass `Error` so consumers can
 * use `err instanceof DarwinNodeError` to distinguish adapter failures
 * from upstream `darwin-agents` or `@langchain/langgraph` errors.
 *
 * Pattern mirrors `mcp-armor` and `darwin-agents@0.4.9` McpBridge*Error
 * (see `nex_decide 34a506ba` for the upstream pattern).
 */

export class DarwinNodeError extends Error {
  public override readonly name = "DarwinNodeError";

  constructor(
    message: string,
    public readonly agentName: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
  }
}

export class DarwinEvolutionHookError extends Error {
  public override readonly name = "DarwinEvolutionHookError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
  }
}
