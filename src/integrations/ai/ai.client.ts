import { Injectable } from "@nestjs/common";

import { InjectConfig } from "../../config/config.module";
import type { Env } from "../../config/env.schema";

/** Typed client for the internal Python AI service. Ingest, embed, answer and judge calls are added per phase. */
@Injectable()
export class AiClient {
  constructor(@InjectConfig() private readonly config: Env) {}

  private headers(): Record<string, string> {
    return { "X-Internal-Key": this.config.INTERNAL_API_KEY };
  }

  /** True when the AI service answers /health in time. Never throws. */
  async isHealthy(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.AI_SERVICE_URL}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
