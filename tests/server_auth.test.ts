import { describe, expect, it } from "vitest";
import http from "http";
import { buildServer } from "../src/server.js";
import { signHmac } from "../src/auth.js";

function post(
  server: http.Server,
  path: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "localhost", port: addr.port, method: "POST", path, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
        });
      }
    );
    req.on("error", (err) => resolve({ status: 0, body: { error: err.message } }));
    req.write(body);
    req.end();
  });
}

describe("server auth (S05)", () => {
  const secret = "server-test-secret";
  const OLD_SECRET = process.env.HMAC_SECRET;

  it("returns 401 when HMAC_SECRET is set but headers are missing", async () => {
    process.env.HMAC_SECRET = secret;
    const server = buildServer();
    await new Promise<void>((r) => server.listen(0, r));

    const res = await post(server, "/query", JSON.stringify({ question: "test" }));
    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>).reason).toBe("missing_auth_header");

    server.closeAllConnections?.();
    server.close();
    process.env.HMAC_SECRET = OLD_SECRET;
  });

  it("returns 401 when signature is invalid", async () => {
    process.env.HMAC_SECRET = secret;
    const server = buildServer();
    await new Promise<void>((r) => server.listen(0, r));

    const body = JSON.stringify({ question: "test" });
    const now = Math.floor(Date.now() / 1000);
    const badSig = signHmac("wrong-secret", now, body);

    const res = await post(server, "/query", body, {
      "X-Timestamp": String(now),
      "X-Signature": badSig,
    });
    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>).reason).toBe("signature_mismatch");

    server.closeAllConnections?.();
    server.close();
    process.env.HMAC_SECRET = OLD_SECRET;
  });

  it("returns 401 when timestamp is expired", async () => {
    process.env.HMAC_SECRET = secret;
    const server = buildServer();
    await new Promise<void>((r) => server.listen(0, r));

    const body = JSON.stringify({ question: "test" });
    const old = Math.floor(Date.now() / 1000) - 400;
    const sig = signHmac(secret, old, body);

    const res = await post(server, "/query", body, {
      "X-Timestamp": String(old),
      "X-Signature": sig,
    });
    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>).reason).toBe("timestamp_expired");

    server.closeAllConnections?.();
    server.close();
    process.env.HMAC_SECRET = OLD_SECRET;
  });

  it("returns 400 for a validly-signed but invalid JSON body", async () => {
    process.env.HMAC_SECRET = secret;
    const server = buildServer();
    await new Promise<void>((r) => server.listen(0, r));

    const body = "not json";
    const now = Math.floor(Date.now() / 1000);
    const sig = signHmac(secret, now, body);

    const res = await post(server, "/query", body, {
      "X-Timestamp": String(now),
      "X-Signature": sig,
    });
    expect(res.status).toBe(400);

    server.closeAllConnections?.();
    server.close();
    process.env.HMAC_SECRET = OLD_SECRET;
  });

  it("returns 200 or 503 on GET /health without auth", async () => {
    process.env.HMAC_SECRET = secret;
    const server = buildServer();
    await new Promise<void>((r) => server.listen(0, r));

    const addr = server.address() as { port: number };
    const res = await new Promise<{ status: number; body: unknown }>((resolve) => {
      http.request(
        { hostname: "localhost", port: addr.port, method: "GET", path: "/health" },
        (response) => {
          let data = "";
          response.on("data", (chunk) => { data += chunk; });
          response.on("end", () => {
            resolve({ status: response.statusCode ?? 0, body: data ? JSON.parse(data) : null });
          });
        }
      ).on("error", (err) => resolve({ status: 0, body: { error: err.message } })).end();
    });

    // 200 if DB available, 503 if DB not available — either is acceptable
    // because it proves the endpoint exists and does not require auth
    expect(res.status === 200 || res.status === 503).toBe(true);

    server.closeAllConnections?.();
    server.close();
    process.env.HMAC_SECRET = OLD_SECRET;
  });
});
