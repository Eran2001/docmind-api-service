import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { APP_CONFIG } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import { DemoRepository } from "../demo/demo.repository";
import { DemoService } from "../demo/demo.service";
import { UsersModule } from "../users/users.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { RefreshTokensRepository } from "./refresh-tokens.repository";
import { TokensService } from "./tokens.service";

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: Env) => ({
        secret: config.JWT_SECRET,
        signOptions: { algorithm: "HS256" },
        verifyOptions: { algorithms: ["HS256"] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokensService,
    RefreshTokensRepository,
    DemoService,
    DemoRepository,
  ],
  exports: [TokensService, AuthService, DemoService],
})
export class AuthModule {}
