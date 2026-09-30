import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError } from "./app-error";
import { toDebugInfo, toErrorEnvelope, toErrorResult } from "./error-response";

describe("toErrorResult", () => {
  it("maps AppError to its code, status and message", () => {
    expect(toErrorResult(AppError.notFound("Collection"))).toEqual({ status: 404, code: "NotFound", message: "Collection not found." });
    expect(toErrorResult(AppError.duplicate("Already uploaded.")).status).toBe(409);
    expect(toErrorResult(AppError.limit("Collection is full.")).status).toBe(422);
    expect(toErrorResult(AppError.aiService())).toMatchObject({ status: 502, code: "AiServiceFailed" });
  });

  it("includes details only when present", () => {
    expect(toErrorResult(AppError.validation("Bad input", { field: "email" })).details).toEqual({ field: "email" });
    expect(toErrorResult(AppError.unauthorized())).not.toHaveProperty("details");
  });

  it("maps a ZodError to ValidationFailed with the flattened issues", () => {
    const parsed = z.object({ name: z.string().min(1) }).safeParse({ name: "" });
    if (parsed.success) throw new Error("expected a failure");
    const res = toErrorResult(parsed.error);
    expect(res).toMatchObject({ status: 400, code: "ValidationFailed" });
    expect(res.details).toHaveProperty("fieldErrors.name");
  });

  it("tells a missing URL (ApiRouteFailed) apart from a missing resource (NotFound)", () => {
    expect(toErrorResult(new NotFoundException())).toMatchObject({ status: 404, code: "ApiRouteFailed", message: "Route not found." });
    expect(toErrorResult(AppError.notFound("Document")).code).toBe("NotFound");
  });

  it("maps other framework and Fastify errors to the API's codes", () => {
    expect(toErrorResult(new BadRequestException("nope")).code).toBe("ValidationFailed");
    expect(toErrorResult(Object.assign(new Error("Too Many Requests"), { statusCode: 429 }))).toMatchObject({ status: 429, code: "RateLimited" });
    expect(toErrorResult(Object.assign(new Error("Unexpected token"), { statusCode: 400 }))).toMatchObject({ status: 400, code: "ValidationFailed" });
    // 4xx without a dedicated code keep their own HTTP status
    expect(toErrorResult(Object.assign(new Error("Payload too large"), { statusCode: 413 }))).toMatchObject({ status: 413, code: "ValidationFailed" });
  });

  it("hides the details of unexpected errors", () => {
    const res = toErrorResult(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"));
    expect(res).toEqual({ status: 500, code: "InternalError", message: "Something went wrong. Please try again." });
    expect(toErrorResult("boom").status).toBe(500);
  });
});

describe("toErrorEnvelope", () => {
  it("has code, error, message, resourceId and requestId, and no data", () => {
    const env = toErrorEnvelope(toErrorResult(AppError.notFound("Collection")), "req-1");
    expect(Object.keys(env)).toEqual(["code", "error", "message", "resourceId", "requestId"]);
    expect(env).toEqual({
      code: "NotFound",
      error: { status: 404 },
      message: "Collection not found.",
      resourceId: null,
      requestId: "req-1",
    });
    expect(env).not.toHaveProperty("data");
  });

  it("puts details in error and debug between error and message", () => {
    const debug = toDebugInfo(new Error("real cause"), { method: "GET", url: "/api/v1/x" });
    const env = toErrorEnvelope(toErrorResult(AppError.validation("Bad", { a: 1 })), "req-2", debug);
    expect(Object.keys(env)).toEqual(["code", "error", "debug", "message", "resourceId", "requestId"]);
    expect(env.error).toEqual({ status: 400, details: { a: 1 } });
    expect(env.debug).toMatchObject({ name: "Error", message: "real cause", method: "GET", path: "/api/v1/x" });
    expect(env.debug?.stack).toContain("real cause");
  });
});
