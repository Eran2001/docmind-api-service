import { Global, Inject, Module } from "@nestjs/common";

import { loadEnv, type Env } from "./env.schema";

export const APP_CONFIG = Symbol("APP_CONFIG");

/** Injects the validated environment: `constructor(@InjectConfig() private readonly config: Env)`. */
export const InjectConfig = () => Inject(APP_CONFIG);

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): Env => loadEnv() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
