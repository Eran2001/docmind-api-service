import { describe, expect, it } from "vitest";

import { createAdapter } from "./app.setup";

async function ipSeenBy(trustProxy: boolean) {
  const adapter = createAdapter({ trustProxy });
  const fastify = adapter.getInstance();
  fastify.get("/ip", (req) => ({ ip: req.ip }));
  await fastify.ready();
  const res = await fastify.inject({
    method: "GET",
    url: "/ip",
    remoteAddress: "10.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.7" },
  });
  await fastify.close();
  return res.json<{ ip: string }>().ip;
}

describe("trustProxy", () => {
  it("sees the proxy's address by default, so a client cannot fake its IP", async () => {
    expect(await ipSeenBy(false)).toBe("10.0.0.1");
  });

  it("sees the real client address from X-Forwarded-For when the proxy is trusted", async () => {
    expect(await ipSeenBy(true)).toBe("203.0.113.7");
  });
});
