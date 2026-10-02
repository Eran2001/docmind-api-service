import { describe, expect, it } from "vitest";

import { costUsd } from "./pricing";

describe("costUsd", () => {
  it("multiplies tokens by the per-million price, input and output separately", () => {
    // gpt-4o-mini: $0.15 in, $0.60 out per million
    expect(costUsd("gpt-4o-mini", 1_000_000, 0)).toBeCloseTo(0.15, 10);
    expect(costUsd("gpt-4o-mini", 0, 1_000_000)).toBeCloseTo(0.6, 10);
    expect(costUsd("gpt-4o-mini", 2000, 500)).toBeCloseTo(0.0006, 10);
  });

  it("charges embeddings for input only", () => {
    expect(costUsd("text-embedding-3-small", 500_000, 0)).toBeCloseTo(0.01, 10);
  });

  it("treats local models as free", () => {
    expect(costUsd("llama3.2", 123_456, 7_890)).toBe(0);
  });

  it("records zero for an unknown model instead of failing", () => {
    expect(costUsd("some-new-model", 1000, 1000)).toBe(0);
  });
});
