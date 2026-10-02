import { Module } from "@nestjs/common";

import { DemoLimitsService } from "./demo-limits.service";

/** The per-visitor limits (questions, uploads). The sandbox itself (DemoService) lives in AuthModule, next to login. */
@Module({ providers: [DemoLimitsService], exports: [DemoLimitsService] })
export class DemoModule {}
