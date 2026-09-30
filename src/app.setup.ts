import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyMultipart from "@fastify/multipart";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { API_PREFIX } from "./config/constants";
import type { Env } from "./config/env.schema";

const REQUEST_ID_PATTERN = /^[\w.-]{8,64}$/;

/** Reuses a sane incoming X-Request-Id (so a trace can span services), otherwise makes a new one. */
export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    requestIdHeader: false,
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    },
  });
}

/** Everything that isn't a module: shared by main.ts and the e2e tests so tests run the real setup. */
export async function configureApp(app: NestFastifyApplication, config: Env): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();

  // Every response, including errors and 404s, carries the id; the logger reads it back from the request headers.
  fastify.addHook("onRequest", async (req, reply) => {
    req.raw.headers["x-request-id"] = req.id;
    void reply.header("x-request-id", req.id);
  });

  app.setGlobalPrefix(API_PREFIX);
  await app.register(fastifyHelmet);
  await app.register(fastifyCookie);
  // File uploads (one file per request). The size limit makes Fastify stop reading an oversized upload early.
  await app.register(fastifyMultipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 5 } });
  app.enableCors({
    origin: config.WEB_ORIGIN,
    credentials: true,
    // The default is only GET, HEAD and POST, which would block every PATCH (edit) and DELETE from the browser.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    exposedHeaders: ["X-Request-Id"],
  });
  app.enableShutdownHooks();
}
