import { Global, Module } from "@nestjs/common";

import { AiClient } from "./ai.client";

@Global()
@Module({ providers: [AiClient], exports: [AiClient] })
export class AiModule {}
