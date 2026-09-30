import { Controller, Get } from "@nestjs/common";

import { Public } from "../../common/decorators/public.decorator";
import { respond } from "../../common/http/api-response";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  async get() {
    const report = await this.health.check();
    // 503 only when the API can't do its job (database or Redis down); a missing AI service is just "degraded".
    if (report.status === "down") {
      return respond.of({ status: 503, code: "ServiceUnavailable", message: "The database or Redis is down.", data: report });
    }
    return respond.ok(report, report.status === "ok" ? "OK" : "Running with some services down.");
  }
}
