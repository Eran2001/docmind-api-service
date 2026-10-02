import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import { describeError } from "../common/utils/describe-error";
import { DemoService } from "../modules/demo/demo.service";

const EVERY_MS = 60 * 60 * 1000;

/** Runs in the worker: once at start and then hourly, deletes demo accounts older than DEMO.TTL_HOURS (and their files). */
@Injectable()
export class DemoCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("DemoCleanup");
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly demo: DemoService) {}

  onModuleInit(): void {
    void this.run();
    this.timer = setInterval(() => void this.run(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    try {
      await this.demo.cleanupExpired();
    } catch (error) {
      this.logger.warn(`Cleanup failed: ${describeError(error)}`);
    }
  }
}
