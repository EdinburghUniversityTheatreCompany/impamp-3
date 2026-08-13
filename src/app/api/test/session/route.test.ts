import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/lib/server/db";
import { POST } from "./route";

/**
 * The test-only sign-in route hands out sessions, so the guard on it is the
 * only thing between an E2E convenience and an authentication bypass.
 */

const SECRET = "test-secret";

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
});

afterEach(() => {
  delete process.env.IMPAMP_E2E_SIGNIN_SECRET;
});

function post(secret?: string, body: unknown = { email: "a@example.com" }) {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== undefined) headers.set("x-impamp-e2e-secret", secret);

  return POST(
    new NextRequest("http://localhost/api/test/session", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/test/session", () => {
  it("does not exist when the secret is not configured", async () => {
    // This is the production case: the env var is never set.
    const response = await post(SECRET);
    expect(response.status).toBe(404);
  });

  it("does not exist to a caller with no secret", async () => {
    process.env.IMPAMP_E2E_SIGNIN_SECRET = SECRET;
    expect((await post()).status).toBe(404);
  });

  it("does not exist to a caller with the wrong secret", async () => {
    process.env.IMPAMP_E2E_SIGNIN_SECRET = SECRET;
    // 404 rather than 401, so probing reveals nothing about the route.
    expect((await post("wrong")).status).toBe(404);
  });

  it("issues a session to a caller with the right secret", async () => {
    process.env.IMPAMP_E2E_SIGNIN_SECRET = SECRET;
    const response = await post(SECRET);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe("a@example.com");
  });

  it("never sets a cookie, which would leak into a shared request context", async () => {
    process.env.IMPAMP_E2E_SIGNIN_SECRET = SECRET;
    const response = await post(SECRET);

    // Playwright's APIRequestContext keeps a cookie jar; a Set-Cookie here
    // would silently authenticate the requests asserting anonymous access.
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a body without a usable email", async () => {
    process.env.IMPAMP_E2E_SIGNIN_SECRET = SECRET;
    expect((await post(SECRET, { email: "not-an-email" })).status).toBe(400);
    expect((await post(SECRET, {})).status).toBe(400);
  });
});
