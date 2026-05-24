import { describe, expect, it } from "vitest";

import { DarwinEvolutionHookError, DarwinNodeError } from "../src/errors.js";

describe("DarwinNodeError", () => {
  it("is an Error subclass", () => {
    const err = new DarwinNodeError("boom", "researcher");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DarwinNodeError);
  });

  it("captures the agent name", () => {
    const err = new DarwinNodeError("boom", "researcher");
    expect(err.agentName).toBe("researcher");
  });

  it("has a stable `name` field for runtime branching", () => {
    const err = new DarwinNodeError("boom", "researcher");
    expect(err.name).toBe("DarwinNodeError");
  });

  it("propagates `cause` for upstream error chaining", () => {
    const cause = new TypeError("upstream");
    const err = new DarwinNodeError("wrap", "researcher", { cause });
    expect(err.cause).toBe(cause);
  });

  it("`message` is what was passed in", () => {
    const err = new DarwinNodeError("explicit message", "x");
    expect(err.message).toBe("explicit message");
  });
});

describe("DarwinEvolutionHookError", () => {
  it("is an Error subclass distinct from DarwinNodeError", () => {
    const err = new DarwinEvolutionHookError("bad config");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DarwinEvolutionHookError);
    expect(err).not.toBeInstanceOf(DarwinNodeError);
  });

  it("has stable `name` field", () => {
    expect(new DarwinEvolutionHookError("x").name).toBe(
      "DarwinEvolutionHookError",
    );
  });

  it("supports `cause`", () => {
    const cause = new Error("inner");
    const err = new DarwinEvolutionHookError("outer", { cause });
    expect(err.cause).toBe(cause);
  });
});
