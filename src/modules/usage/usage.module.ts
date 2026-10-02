import { Module } from "@nestjs/common";

import { AdminUsageController } from "./admin-usage.controller";
import { UsageController } from "./usage.controller";
import { UsageRepository } from "./usage.repository";
import { UsageService } from "./usage.service";

@Module({
  controllers: [UsageController, AdminUsageController],
  providers: [UsageRepository, UsageService],
})
export class UsageModule {}
