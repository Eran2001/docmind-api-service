import { Logger } from "@nestjs/common";

/** USD per million tokens, standard tier. Checked against developers.openai.com/api/docs/pricing on 2026-10-03. */
export const MODEL_PRICES_PER_MILLION: Readonly<
  Record<string, { input: number; output: number }>
> = {
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  // GPT-5 family: reasoning tokens are billed as output tokens.
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  // Local models (Ollama) cost nothing.
  "llama3.2": { input: 0, output: 0 },
};

const logger = new Logger("Pricing");
const warned = new Set<string>();

/** `in / 1e6 * inputPrice + out / 1e6 * outputPrice`. An unknown model costs 0 and is logged once (spec 7.x). */
export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICES_PER_MILLION[model];
  if (!price) {
    if (!warned.has(model)) {
      warned.add(model);
      logger.warn(
        `No usage price configured for model "${model}"; recording zero cost. Add it to modules/usage/pricing.ts.`,
      );
    }
    return 0;
  }
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
