import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "isPublic";

/** Routes are protected by default (global JwtAuthGuard). `@Public()` opens one up: register, login, health. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
