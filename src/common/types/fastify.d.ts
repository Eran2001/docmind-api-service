import "fastify";

/** Who the request is from, set by JwtAuthGuard after the access token checks out. */
export interface AuthUser {
  id: string;
  role: "user" | "admin";
  /** True for "Try the demo" sandbox accounts. Read from the access token, so no database lookup. */
  demo?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}
