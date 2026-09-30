import { Controller, Delete, Get, HttpCode, Post } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configureApp, createAdapter } from "../src/app.setup";
import { RawResponse } from "../src/common/decorators/raw-response.decorator";
import { AppError } from "../src/common/errors/app-error";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { respond } from "../src/common/http/api-response";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { APP_CONFIG } from "../src/config/config.module";
import { loadEnv } from "../src/config/env.schema";

@Controller("demo")
class DemoController {
  @Get("plain") plain() {
    return { hello: "world" };
  }
  @Get("one") one() {
    return respond.ok({ id: "1", name: "Handbook" });
  }
  @Get("list") list() {
    return respond.list([{ id: 1 }, { id: 2 }], { total: 12, nextCursor: "abc" });
  }
  @Get("empty-list") emptyList() {
    return respond.list([]);
  }
  @Post() create() {
    return respond.created({ id: "doc-1", status: "queued" }, "doc-1");
  }
  @Post("jobs") job() {
    return respond.accepted({ id: "run-1" }, "run-1");
  }
  @Get("raw") @RawResponse() raw() {
    return { untouched: true };
  }
  @Delete("1") @HttpCode(204) remove() {
    return undefined;
  }
  @Get("missing") missing() {
    throw AppError.notFound("Collection");
  }
}

describe("response envelope", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DemoController],
      providers: [
        { provide: APP_CONFIG, useValue: loadEnv(process.env) },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), { logger: false });
    await configureApp(app, loadEnv(process.env));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (url: string, method: "GET" | "POST" | "DELETE" = "GET") => app.inject({ method, url: `/api/v1/demo${url}` });

  it("wraps a plain returned value as an OK envelope with the request id", async () => {
    const res = await get("/plain");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code: "OK", data: { hello: "world" }, message: "OK", resourceId: null, requestId: res.headers["x-request-id"] });
    expect(Object.keys(res.json())).toEqual(["code", "data", "message", "resourceId", "requestId"]);
  });

  it("respond.ok puts the object under data", async () => {
    expect((await get("/one")).json().data).toEqual({ id: "1", name: "Handbook" });
  });

  it("respond.list puts the rows under data.result, with optional paging info", async () => {
    const body = (await get("/list")).json();
    expect(body.data).toEqual({ result: [{ id: 1 }, { id: 2 }], total: 12, nextCursor: "abc" });
    expect(Array.isArray(body.data.result)).toBe(true);
    expect((await get("/empty-list")).json().data).toEqual({ result: [] });
  });

  it("respond.created is 201 with the new resourceId", async () => {
    const res = await get("", "POST");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ code: "OK", message: "Created", resourceId: "doc-1", data: { id: "doc-1", status: "queued" } });
  });

  it("respond.accepted is 202", async () => {
    const res = await get("/jobs", "POST");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ code: "OK", message: "Accepted", resourceId: "run-1" });
  });

  it("leaves @RawResponse endpoints alone", async () => {
    expect((await get("/raw")).json()).toEqual({ untouched: true });
  });

  it("sends nothing for a 204", async () => {
    const res = await get("/1", "DELETE");
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });

  it("returns failures in the same envelope: code, error (no data), debug, message, resourceId, requestId", async () => {
    const res = await get("/missing");
    const body = res.json();
    expect(res.statusCode).toBe(404);
    expect(Object.keys(body)).toEqual(["code", "error", "debug", "message", "resourceId", "requestId"]);
    expect(body).toMatchObject({
      code: "NotFound",
      error: { status: 404 },
      message: "Collection not found.",
      resourceId: null,
      requestId: res.headers["x-request-id"],
    });
    expect(body).not.toHaveProperty("data");
    expect(body.debug).toMatchObject({ name: "AppError", method: "GET", path: "/api/v1/demo/missing" });
  });

  it("uses ApiRouteFailed for a URL that does not exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "ApiRouteFailed", message: "Route not found.", error: { status: 404 } });
  });
});

describe("debug field", () => {
  it("is left out in production", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DemoController],
      providers: [
        { provide: APP_CONFIG, useValue: { ...loadEnv(process.env), NODE_ENV: "production" } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      ],
    }).compile();
    const prod = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), { logger: false });
    await configureApp(prod, loadEnv(process.env));
    await prod.init();
    await prod.getHttpAdapter().getInstance().ready();

    const body = (await prod.inject({ method: "GET", url: "/api/v1/demo/missing" })).json();
    expect(Object.keys(body)).toEqual(["code", "error", "message", "resourceId", "requestId"]);
    expect(body).not.toHaveProperty("debug");
    await prod.close();
  });
});
