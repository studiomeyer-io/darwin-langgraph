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

/**
 * Thrown by `createTokenBudgetCallbacks` when a configured per-invocation
 * token budget is exceeded. The handler attaches the cumulative tokens
 * counted at the moment of the throw so consumers can log / alert.
 *
 * NEW V0.4 (S1235).
 */
export class DarwinTokenBudgetExceededError extends Error {
  public override readonly name = "DarwinTokenBudgetExceededError";

  constructor(
    message: string,
    public readonly budget: number,
    public readonly totalTokens: number,
    public readonly providerHint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
  }
}
