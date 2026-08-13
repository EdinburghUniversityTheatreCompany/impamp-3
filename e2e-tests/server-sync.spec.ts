import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { E2E_DB_PATH } from "../playwright.config";

/**
 * End-to-end coverage for server sync.
 *
 * Signing in normally needs a real Google account, which no test can do, so
 * these tests mint a session straight into the server's database — the same
 * row `/api/auth/google/exchange` would have written. Everything after that
 * point is the real server: real routes, real SQLite, real SSE.
 */

const SESSION_COOKIE = "impamp_session";

/**
 * Create a user (if new) and a session for it, returning the raw cookie value.
 * The server stores only a hash, so the token has to be generated here.
 */
function mintSession(email: string): string {
  const db = new DatabaseSync(E2E_DB_PATH);
  try {
    const sub = `e2e-${email}`;
    const now = Date.now();

    let user = db
      .prepare("SELECT id FROM users WHERE google_sub = ?")
      .get(sub) as { id: number } | undefined;

    if (!user) {
      const { count } = db
        .prepare("SELECT COUNT(*) AS count FROM users")
        .get() as { count: number };
      db.prepare(
        `INSERT INTO users (google_sub, email, name, picture, is_admin, can_upload_audio, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 0, ?, ?)`,
      ).run(sub, email, email, count === 0 ? 1 : 0, now, now);
      user = db
        .prepare("SELECT id FROM users WHERE google_sub = ?")
        .get(sub) as {
        id: number;
      };
    }

    const token = randomBytes(32).toString("base64url");
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      createHash("sha256").update(token).digest("hex"),
      user.id,
      now,
      now + 3600_000,
    );

    return token;
  } finally {
    db.close();
  }
}

/**
 * The database is created lazily on the first request that touches it, so the
 * tables may not exist until the app has been asked something. One anonymous
 * request with a cookie is enough to force the migrations to run.
 */
async function ensureDatabaseReady(request: APIRequestContext): Promise<void> {
  await request.get("/api/auth/session", {
    headers: { cookie: `${SESSION_COOKIE}=force-init` },
  });
}

async function signIn(page: Page, token: string): Promise<void> {
  await page.context().addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      domain: "localhost",
      path: "/",
    },
  ]);
}

const SAMPLE = {
  _syncFormatVersion: 1,
  padConfigurations: [],
  pageMetadata: [],
};

test.describe("server sync API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureDatabaseReady(request);
  });

  test("refuses anonymous callers", async ({ request }) => {
    expect((await request.get("/api/profiles")).status()).toBe(401);
    expect((await request.get("/api/auth/session")).status()).toBe(401);
  });

  test("round-trips a profile with ETag and If-Match", async ({ request }) => {
    const token = mintSession("etag@example.com");
    const cookie = { cookie: `${SESSION_COOKIE}=${token}` };

    const created = await request.post("/api/profiles", {
      headers: cookie,
      data: { name: "E2E Show", data: SAMPLE },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json();

    const fetched = await request.get(`/api/profiles/${id}`, {
      headers: cookie,
    });
    expect(fetched.headers()["etag"]).toBe('"1"');

    // Already current → 304 with no body, which is what keeps polling cheap.
    const unchanged = await request.get(`/api/profiles/${id}`, {
      headers: { ...cookie, "if-none-match": '"1"' },
    });
    expect(unchanged.status()).toBe(304);

    const updated = await request.put(`/api/profiles/${id}`, {
      headers: { ...cookie, "if-match": '"1"' },
      data: { name: "E2E Show", data: { ...SAMPLE, edited: true } },
    });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).version).toBe(2);
  });

  test("rejects a stale write and hands back the winning data", async ({
    request,
  }) => {
    const token = mintSession("conflict@example.com");
    const cookie = { cookie: `${SESSION_COOKIE}=${token}` };

    const { id } = await (
      await request.post("/api/profiles", {
        headers: cookie,
        data: { name: "Race", data: SAMPLE },
      })
    ).json();

    await request.put(`/api/profiles/${id}`, {
      headers: { ...cookie, "if-match": '"1"' },
      data: { name: "Race", data: { who: "winner" } },
    });

    const stale = await request.put(`/api/profiles/${id}`, {
      headers: { ...cookie, "if-match": '"1"' },
      data: { name: "Race", data: { who: "loser" } },
    });

    expect(stale.status()).toBe(409);
    const body = await stale.json();
    expect(body.version).toBe(2);
    expect(body.data).toEqual({ who: "winner" });

    // A blind write is refused outright rather than silently winning.
    const blind = await request.put(`/api/profiles/${id}`, {
      headers: cookie,
      data: { name: "Race", data: { who: "blind" } },
    });
    expect(blind.status()).toBe(428);
  });

  test("share links let an anonymous viewer read but not write", async ({
    request,
  }) => {
    const token = mintSession("sharer@example.com");
    const cookie = { cookie: `${SESSION_COOKIE}=${token}` };

    const { id } = await (
      await request.post("/api/profiles", {
        headers: cookie,
        data: { name: "Shared", data: SAMPLE },
      })
    ).json();

    const { share } = await (
      await request.post(`/api/profiles/${id}/shares`, {
        headers: cookie,
        data: { role: "viewer" },
      })
    ).json();

    // No cookie at all — the token is the whole credential.
    const anonymous = await request.get(
      `/api/profiles/${id}?token=${share.linkToken}`,
    );
    expect(anonymous.status()).toBe(200);
    expect((await anonymous.json()).access).toBe("viewer");

    const write = await request.put(
      `/api/profiles/${id}?token=${share.linkToken}`,
      {
        headers: { "if-match": '"1"' },
        data: { name: "Shared", data: { hijacked: true } },
      },
    );
    expect(write.status()).toBe(403);
  });

  test("hides profiles the caller has no grant on", async ({ request }) => {
    const owner = mintSession("owner2@example.com");
    const stranger = mintSession("stranger@example.com");

    const { id } = await (
      await request.post("/api/profiles", {
        headers: { cookie: `${SESSION_COOKIE}=${owner}` },
        data: { name: "Private", data: SAMPLE },
      })
    ).json();

    // 404 rather than 403, so profile IDs can't be enumerated by probing.
    const probe = await request.get(`/api/profiles/${id}`, {
      headers: { cookie: `${SESSION_COOKIE}=${stranger}` },
    });
    expect(probe.status()).toBe(404);
  });
});

test.describe("server sync UI", () => {
  test.beforeEach(async ({ request }) => {
    await ensureDatabaseReady(request);
  });

  test("a broken share link explains itself", async ({ page }) => {
    await page.goto("/server/open");
    await expect(page.getByText(/missing its profile or token/i)).toBeVisible();
  });

  test("enabling server sync exposes the sharing controls", async ({
    page,
    request,
  }) => {
    await signIn(page, mintSession("ui@example.com"));
    await page.goto("/");

    await page
      .getByRole("button", { name: /Profile/i })
      .first()
      .click();
    const manage = page.getByText(/Manage Profiles/i).first();
    if (await manage.count()) await manage.click();

    const enable = page.getByTestId("enable-server-sync").first();
    await expect(enable).toBeVisible();
    await enable.click();

    await expect(page.getByTestId("server-sharing-panel")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Server Sync").first()).toBeVisible();

    // The profile really reached the server, not just the local UI.
    await expect
      .poll(
        async () => {
          const response = await request.get("/api/profiles", {
            headers: { cookie: await sessionCookieOf(page) },
          });
          return (await response.json()).profiles.length;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
  });
});

/** Read back the session cookie the browser is carrying. */
async function sessionCookieOf(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === SESSION_COOKIE);
  return `${SESSION_COOKIE}=${session?.value ?? ""}`;
}
