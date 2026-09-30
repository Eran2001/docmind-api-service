import { describe, expect, it } from "vitest";

import { respond, toEnvelope } from "./api-response";

describe("respond", () => {
  it("ok defaults to code OK, message OK and no status override", () => {
    const res = respond.ok({ a: 1 });
    expect(res).toMatchObject({ code: "OK", message: "OK", data: { a: 1 } });
    expect(res.status).toBeUndefined();
  });

  it("list nests the rows in data.result and only includes the meta that was given", () => {
    expect(respond.list([{ id: 1 }]).data).toEqual({ result: [{ id: 1 }] });
    expect(respond.list([], { total: 0, nextCursor: null }).data).toEqual({ result: [], total: 0, nextCursor: null });
  });

  it("done and createdDone send { result: true } and never the record", () => {
    expect(respond.done("Deleted", "id-1")).toMatchObject({ status: undefined, code: "OK", message: "Deleted", resourceId: "id-1", data: { result: true } });
    expect(respond.createdDone("id-2", "Collection created.")).toMatchObject({ status: 201, code: "OK", resourceId: "id-2", data: { result: true } });
  });

  it("created and accepted set the status and resource id but keep code OK", () => {
    expect(respond.created({}, "id-1")).toMatchObject({ status: 201, code: "OK", message: "Created", resourceId: "id-1" });
    expect(respond.accepted({}, "id-2")).toMatchObject({ status: 202, code: "OK", message: "Accepted", resourceId: "id-2" });
  });
});

describe("toEnvelope", () => {
  it("orders the keys code, data, message, resourceId, requestId", () => {
    const env = toEnvelope(respond.ok({ a: 1 }), "req-1");
    expect(Object.keys(env)).toEqual(["code", "data", "message", "resourceId", "requestId"]);
    expect(env).toEqual({ code: "OK", data: { a: 1 }, message: "OK", resourceId: null, requestId: "req-1" });
  });

  it("carries the resource id when there is one", () => {
    expect(toEnvelope(respond.created({ a: 1 }, "x"), "req-1").resourceId).toBe("x");
  });
});
