import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { E2E_SIGNIN_SECRET } from "../playwright.config";

/**
 * End-to-end coverage for server sync.
 *
 * Signing in normally needs a real Google account, which no test can do, so
 * these tests use the server's test-only sign-in route (see
 * `src/app/api/test/session/route.ts`, which only exists when the suite hands
 * it a secret). Everything after that point is the real server: real routes,
 * real SQLite, real SSE.
 *
 * The sign-in deliberately goes *through the server* rather than writing a
 * session row into the SQLite file directly. `node:sqlite` is synchronous, so
 * a second writer competing for the lock blocks the server's whole event loop
 * and stalls unrelated specs.
 */

const SESSION_COOKIE = "impamp_session";

/** Sign in as `email`, returning the raw session token. */
async function mintSession(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  const response = await request.post("/api/test/session", {
    headers: { "x-impamp-e2e-secret": E2E_SIGNIN_SECRET },
    data: { email },
  });
  expect(
    response.status(),
    "test sign-in route should be enabled during E2E",
  ).toBe(200);
  return (await response.json()).token as string;
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
  test("refuses anonymous callers", async ({ request }) => {
    expect((await request.get("/api/profiles")).status()).toBe(401);
    expect((await request.get("/api/auth/session")).status()).toBe(401);
  });

  test("round-trips a profile with ETag and If-Match", async ({ request }) => {
    const token = await mintSession(request, "etag@example.com");
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
    const token = await mintSession(request, "conflict@example.com");
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
    const token = await mintSession(request, "sharer@example.com");
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
    const owner = await mintSession(request, "owner2@example.com");
    const stranger = await mintSession(request, "stranger@example.com");

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
  test("a broken share link explains itself", async ({ page }) => {
    await page.goto("/server/open");
    await expect(page.getByText(/missing its profile or token/i)).toBeVisible();
  });

  test("a share link imports the profile it points at", async ({
    page,
    request,
  }) => {
    const token = await mintSession(request, "linksharer@example.com");
    const cookie = { cookie: `${SESSION_COOKIE}=${token}` };

    // A full ProfileSyncData payload: the client-side import needs the
    // `profile` metadata, which SAMPLE (written for the API tests) omits.
    const now = Date.now();
    const syncData = {
      _syncFormatVersion: 1,
      profile: {
        name: "Shared By Link",
        syncType: "server",
        lastBackedUpAt: now,
        backupReminderPeriod: 30,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
      padConfigurations: [],
      pageMetadata: [],
      audioFiles: [],
    };

    const { id } = await (
      await request.post("/api/profiles", {
        headers: cookie,
        data: { name: "Shared By Link", data: syncData },
      })
    ).json();

    const { share } = await (
      await request.post(`/api/profiles/${id}/shares`, {
        headers: cookie,
        data: { role: "viewer" },
      })
    ).json();

    // Anonymous: the link token is the whole credential.
    await page.goto(`/server/open?id=${id}&token=${share.linkToken}`);
    await expect(page.getByText("Shared By Link")).toBeVisible();
    await expect(page.getByText(/view-only/i)).toBeVisible();

    // Opening the same link again recognises the profile instead of importing
    // a second copy.
    await page.goto(`/server/open?id=${id}&token=${share.linkToken}`);
    await expect(page.getByText(/already have/i)).toBeVisible();
  });

  test("enabling server sync exposes the sharing controls", async ({
    page,
    request,
  }) => {
    await signIn(page, await mintSession(request, "ui@example.com"));
    await page.goto("/");

    await page
      .getByRole("button", { name: /Profile/i })
      .first()
      .click();
    const manage = page.getByText(/Manage Profiles/i).first();
    if (await manage.count()) await manage.click();

    // Everything about syncing now lives behind the profile's status chip.
    const chip = page.getByTestId("sync-status-chip").first();
    await expect(chip).toHaveText(/This device only/);
    await chip.click();

    const enable = page.getByTestId("enable-server-sync").first();
    await expect(enable).toBeVisible();
    await enable.click();

    await expect(page.getByTestId("server-sharing-panel")).toBeVisible({
      timeout: 15_000,
    });
    // The chip is the profile's own account of itself, so it has to move too.
    await expect(chip).toHaveText(/ImpAmp server/, { timeout: 15_000 });

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

/**
 * Hosted audio is opt-in infrastructure: the E2E server sets no IMPAMP_S3_*
 * variables, so this asserts the promise that a deployment which configures
 * nothing hosts nothing — and says so rather than half-working.
 */
test.describe("hosted audio, unconfigured", () => {
  test("every audio route reports the feature is off", async ({
    page,
    request,
  }) => {
    const token = await mintSession(request, "audio-off@example.com");
    await signIn(page, token);
    const cookie = `${SESSION_COOKIE}=${token}`;

    const library = await request.get("/api/audio", { headers: { cookie } });
    expect(library.status()).toBe(501);

    // 404, not 501: the admin check runs first, so an ordinary account cannot
    // learn whether the deployment hosts audio — or that the surface exists.
    const admin = await request.get("/api/admin/audio", {
      headers: { cookie },
    });
    expect(admin.status()).toBe(404);

    const upload = await request.post("/api/audio/upload-url", {
      headers: { cookie },
      data: {
        hash: "a".repeat(64),
        sizeBytes: 1024,
        contentType: "audio/wav",
        extension: "wav",
      },
    });
    expect(upload.status()).toBe(501);
  });

  test("the storage page still loads and explains itself", async ({ page }) => {
    await page.goto("/server/storage");
    await expect(
      page.getByRole("heading", { name: "Server audio storage" }),
    ).toBeVisible();
    // No allowance bar for a feature that is not switched on.
    await expect(page.getByRole("progressbar")).toHaveCount(0);
  });
});

/** Read back the session cookie the browser is carrying. */
async function sessionCookieOf(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === SESSION_COOKIE);
  return `${SESSION_COOKIE}=${session?.value ?? ""}`;
}
