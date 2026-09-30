import "fastify";

/** Who the request is from, set by JwtAuthGuard after the access token checks out. */
export interface AuthUser {
  id: string;
  role: "user" | "admin";
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}
