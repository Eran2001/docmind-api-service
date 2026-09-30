import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeError, throttle } from "./describe-error";

describe("describeError", () => {
  it("uses the message, falling back to the error code or name when it is empty", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(Object.assign(new Error(""), { code: "ECONNREFUSED" }))).toBe("Error (ECONNREFUSED)");
    expect(describeError(new AggregateError([]))).toBe("AggregateError");
    expect(describeError("plain")).toBe("plain");
  });
});

describe("throttle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("logs once per interval", () => {
    const log = vi.fn();
    const warn = throttle(log, 1000);
    warn("a");
    warn("b");
    expect(log).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    warn("c");
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith("c");
  });
});
