import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  E2E_ADMIN_EMAIL,
  E2E_S3_PORT,
  E2E_SIGNIN_SECRET,
} from "../playwright.config";
import {
  gotoApp,
  openProfileManager,
  readActiveProfile,
  seedActiveProfileSync,
  waitForAppReady,
} from "./test-helpers";

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

/**
 * Sign in as a brand-new account, returning the raw session token.
 *
 * `who` names the role the test needs, not an address: the address is minted
 * fresh every time on purpose. `/api/test/session` reuses the user behind a
 * given address, and while `e2e-tests/reset-db.js` now empties the database
 * when the server starts, a developer runs many suites against one server.
 * Twelve of the sixteen sign-ins here used to pass a literal, so each account
 * carried one profile per run the suite had ever done on that machine — nine,
 * eighteen — and every assertion that counted something was measuring history.
 *
 * "Enabling server sync exposes the sharing controls" is what that cost. It
 * ended in `expect.poll(() => profiles.length).toBeGreaterThan(0)`, the one
 * assertion separating "the adopt reached the server" from "a label changed
 * locally", and the poll's first sample already read 9. If adoption stopped
 * writing to the server entirely, that test would have stayed green on every
 * developer machine.
 */
async function mintSession(
  request: APIRequestContext,
  who: string,
  // Only the admin passes one: its identity is fixed because admin is decided
  // by sign-in order rather than by a flag. See e2e-tests/global-setup.ts.
  exactEmail?: string,
): Promise<{ token: string; email: string; userId: number; isAdmin: boolean }> {
  const email =
    exactEmail ??
    `${who}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const response = await request.post("/api/test/session", {
    headers: { "x-impamp-e2e-secret": E2E_SIGNIN_SECRET },
    data: { email },
  });
  expect(
    response.status(),
    "test sign-in route should be enabled during E2E",
  ).toBe(200);
  const body = await response.json();
  return {
    token: body.token as string,
    email,
    userId: body.user.id as number,
    isAdmin: body.user.isAdmin as boolean,
  };
}

/** A throwaway account, signed in on both the page and the API client. */
async function signedInAs(
  page: Page,
  request: APIRequestContext,
  who: string,
): Promise<{ cookie: string }> {
  const { token } = await mintSession(request, who);
  await signIn(page, token);
  return { cookie: `${SESSION_COOKIE}=${token}` };
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

/** An empty profile on the server, for a test to then connect or watch. */
async function createServerProfile(
  request: APIRequestContext,
  cookie: { cookie: string },
  name: string,
): Promise<string> {
  const now = Date.now();
  const created = await request.post("/api/profiles", {
    headers: cookie,
    data: {
      name,
      data: {
        _syncFormatVersion: 1,
        profile: {
          name,
          syncType: "server",
          lastBackedUpAt: now,
          backupReminderPeriod: 30,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        },
        padConfigurations: [],
        pageMetadata: [],
        audioFiles: [],
      },
    },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).id as string;
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
    const { token } = await mintSession(request, "etag");
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
    // The GET tag carries the access as well as the version: the body states
    // it, and a promotion changes it without moving the version.
    expect(fetched.headers()["etag"]).toBe('"1.owner"');

    // Already current → 304 with no body, which is what keeps polling cheap.
    const unchanged = await request.get(`/api/profiles/${id}`, {
      headers: { ...cookie, "if-none-match": '"1.owner"' },
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
    const { token } = await mintSession(request, "conflict");
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
    const { token } = await mintSession(request, "sharer");
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

  /**
   * A revoked link must stop reading. Nothing tested this: shares were created
   * and read all over this file and never withdrawn, so a `DELETE` that
   * answered `{ ok: true }` without touching the row would have left every
   * issued link live forever. A share you believe you have recalled but which
   * still serves the profile is a silent data leak, and the UI would report
   * success either way.
   */
  test("revoking a share link stops it reading, and only the owner may", async ({
    request,
  }) => {
    const { token } = await mintSession(request, "revoker");
    const cookie = { cookie: `${SESSION_COOKIE}=${token}` };
    const { token: outsider } = await mintSession(request, "outsider");

    const { id } = await (
      await request.post("/api/profiles", {
        headers: cookie,
        data: { name: "Revocable", data: SAMPLE },
      })
    ).json();

    const { share } = await (
      await request.post(`/api/profiles/${id}/shares`, {
        headers: cookie,
        data: { role: "viewer" },
      })
    ).json();
    const link = `/api/profiles/${id}?token=${share.linkToken}`;

    expect((await request.get(link)).status()).toBe(200);

    // Someone else's session cannot revoke it, and is told nothing about the
    // profile's existence while being refused.
    const byOutsider = await request.delete(
      `/api/profiles/${id}/shares/${share.id}`,
      { headers: { cookie: `${SESSION_COOKIE}=${outsider}` } },
    );
    expect(byOutsider.status()).toBe(404);
    expect((await request.get(link)).status()).toBe(200);

    // Nor does holding the link grant power over the link.
    const bySelf = await request.delete(
      `/api/profiles/${id}/shares/${share.id}?token=${share.linkToken}`,
    );
    expect(bySelf.status()).toBe(403);
    expect((await request.get(link)).status()).toBe(200);

    const revoked = await request.delete(
      `/api/profiles/${id}/shares/${share.id}`,
      { headers: cookie },
    );
    expect(revoked.status()).toBe(200);

    // The credential is dead, and answers as if the profile never existed.
    expect((await request.get(link)).status()).toBe(404);
    // And it is gone from the owner's listing, not merely disabled.
    const listed = await (
      await request.get(`/api/profiles/${id}/shares`, { headers: cookie })
    ).json();
    expect(listed.shares).toEqual([]);

    // Revoking twice is a 404, not a second success.
    const again = await request.delete(
      `/api/profiles/${id}/shares/${share.id}`,
      { headers: cookie },
    );
    expect(again.status()).toBe(404);
  });

  test("hides profiles the caller has no grant on", async ({ request }) => {
    const { token: owner } = await mintSession(request, "owner2");
    const { token: stranger } = await mintSession(request, "stranger");

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
    const { token } = await mintSession(request, "linksharer");
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
    await signIn(page, (await mintSession(request, "ui")).token);
    await gotoApp(page);
    await openProfileManager(page);

    // Measured before the act, so the assertion at the end is about what this
    // test did rather than about how many profiles the account happens to
    // hold. It used to sign in as a fixed address against a database nothing
    // reset, so the account already had one profile per run the suite had ever
    // done on this machine and `toBeGreaterThan(0)` passed on its first sample.
    const profileCount = async () =>
      (
        await (
          await request.get("/api/profiles", {
            headers: { cookie: await sessionCookieOf(page) },
          })
        ).json()
      ).profiles.length as number;
    const before = await profileCount();

    // Everything about syncing now lives behind the profile's status chip,
    // and turning it on is choosing where the profile syncs rather than
    // pressing a button that only exists in one direction.
    const chip = page.getByTestId("sync-status-chip").first();
    await expect(chip).toHaveText(/This device only/);
    await chip.click();

    await page.getByTestId("sync-target-server").getByRole("radio").click();

    await expect(page.getByTestId("server-sharing-panel")).toBeVisible({
      timeout: 15_000,
    });
    // The chip is the profile's own account of itself, so it has to move too.
    await expect(chip).toHaveText(/ImpAmp server/, { timeout: 15_000 });

    // The profile really reached the server, not just the local UI.
    await expect.poll(profileCount, { timeout: 15_000 }).toBe(before + 1);
  });
});

/**
 * A server-sync conflict used to be a dead end. `useServerSync` computed the
 * list of conflicts and nothing consumed it; the only visible sign was a red
 * line reading "Sync conflicts detected. Manual resolution required." with
 * nothing to click, so the profile stopped converging until someone changed
 * something by hand.
 *
 * Staged for real: enable server sync, rename the profile locally, then write
 * a different name to the server with a newer stamp. Both sides have moved
 * since the other last saw it, which is exactly what the merge calls a
 * conflict.
 */
/**
 * Turn a freshly server-synced profile into a genuine conflict: rename it
 * locally, then write a different name to the server with a later stamp. Both
 * sides have moved since the other last saw it, which is the only thing the
 * merge treats as a conflict rather than a merge.
 */
async function stageServerConflict(
  page: Page,
  request: APIRequestContext,
  cookie: { cookie: string },
): Promise<{ serverId: string; version: number }> {
  await gotoApp(page);
  await openProfileManager(page);
  await page.getByTestId("sync-status-chip").first().click();
  await page.getByTestId("sync-target-server").getByRole("radio").click();
  // Generous: this is setup, and it is a real adopt over the network competing
  // with every other spec in the run.
  await expect(page.getByTestId("server-sharing-panel")).toBeVisible({
    timeout: 30_000,
  });

  // updateProfile stamps _fieldsModified.name, which is what makes this side
  // "changed since the server last saw it".
  await seedActiveProfileSync(page, { name: "Mine" });

  const list = await (
    await request.get("/api/profiles", { headers: cookie })
  ).json();
  const serverId = list.profiles[0].id as string;

  // The app is syncing this profile at the same time, so the version can move
  // between reading it and writing — which is the whole point of If-Match.
  // Re-read and retry rather than pretending the race isn't there.
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await (
      await request.get(`/api/profiles/${serverId}`, { headers: cookie })
    ).json();

    const put = await request.put(`/api/profiles/${serverId}`, {
      headers: { ...cookie, "if-match": `"${current.version}"` },
      data: {
        name: "Theirs",
        data: {
          ...current.data,
          _lastSyncTimestamp: 0,
          profile: {
            ...current.data.profile,
            name: "Theirs",
            _fieldsModified: { name: Date.now() + 60_000 },
          },
        },
      },
    });
    if (put.status() === 200) {
      return { serverId, version: current.version as number };
    }
    expect(put.status(), "only a lost race is worth retrying").toBe(409);
  }

  throw new Error("Could not stage a conflict: the client kept winning.");
}

/**
 * Reload, which syncs on load, and wait for the conflict to surface.
 *
 * Deliberately not a wait on the background timers. The change reaches a
 * running client over SSE, but only once it has subscribed, and under a
 * parallel run the write can land in that gap — leaving a 30-second poll as
 * the next trigger and the test failing on how busy the machine is rather than
 * on anything about the app. `ClientSideInitializer` syncs every server-synced
 * profile when it mounts, so a reload is a trigger we control.
 */
async function reloadAndWaitForConflict(page: Page) {
  await page.reload();
  await waitForAppReady(page);
  // Not optional: the modal is opened from an effect in `ProfileCard`, and no
  // card is mounted until the manager is. Removing this step while testing the
  // rest of this helper produced a clean 30-second timeout on a page that had
  // detected the conflict perfectly well.
  await openProfileManager(page);

  await expect(page.getByTestId("custom-modal")).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("server sync conflicts", () => {
  /*
   * These used to carry `test.describe.configure({ retries: 2 })`, argued for
   * on the grounds that a retry "cannot hide a regression: if conflicts
   * stopped surfacing, every attempt would fail". That is true of a total
   * regression and false of a partial one, and the retry was firing routinely
   * rather than rarely — the account behind the first test had accumulated
   * twice as many profiles as its sibling, which is one per attempt, so it had
   * been averaging two attempts a run. A newly introduced 50 % flake would
   * have landed inside a budget a permanent one was already consuming.
   *
   * The permanent one had a cause: the lost-update bug where a merge computed
   * against a pre-rename snapshot wrote `_fieldsModified.name = 0` back over a
   * name the user had just changed, so no conflict was ever detected. That is
   * fixed, and the describe now takes the config's default — none locally, the
   * usual two in CI. If either of these starts needing a retry again, that is
   * a report about the app and should be visible as one.
   */

  test("a conflict opens the resolution modal, naming the server", async ({
    page,
    request,
  }) => {
    const { token } = await mintSession(request, "conflicted");
    await signIn(page, token);
    const cookie = { cookie: `${SESSION_COOKIE}=${token}` };

    await stageServerConflict(page, request, cookie);

    // The sync that finds this runs in the initializer's hook instance, not
    // the card's — the case that used to be detected, recorded, and shown to
    // nobody.
    await reloadAndWaitForConflict(page);
    const modal = page.getByTestId("custom-modal");
    // The copy used to say "Google Drive" whichever backend it was about.
    await expect(modal).toContainText(/the ImpAmp server/);
    await expect(modal).toContainText(/Mine|Theirs/);
  });

  test("resolving a conflict settles it and clears the modal", async ({
    page,
    request,
  }) => {
    const { token } = await mintSession(request, "resolver");
    await signIn(page, token);
    const cookie = { cookie: `${SESSION_COOKIE}=${token}` };

    const { serverId, version } = await stageServerConflict(
      page,
      request,
      cookie,
    );

    await expect(page.getByTestId("custom-modal")).toBeVisible({
      timeout: 20_000,
    });
    // The button stays disabled until every conflict has an answer, so choose
    // one first — this is a real decision, not a rubber stamp.
    await page
      .getByRole("radio", { name: /Keep Local/i })
      .first()
      .check();
    await page.getByRole("button", { name: /Resolve Conflicts/i }).click();

    // Settled: the modal goes, and the server holds a newer version than the
    // one the conflict was against.
    await expect(page.getByTestId("custom-modal")).toBeHidden({
      timeout: 15_000,
    });
    await expect
      .poll(
        async () => {
          const after = await (
            await request.get(`/api/profiles/${serverId}`, { headers: cookie })
          ).json();
          return after.version;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(version + 1);
  });
});

/**
 * `listServerProfiles` existed and was called from nowhere, so signing in on a
 * new device showed no sign of your own server profiles — the only route back
 * to one was a share link, which assumes somebody else is involved. Drive had
 * a list; the server had nothing.
 */
test.describe("connecting a profile", () => {
  test("lists your server profiles, with no Google account involved", async ({
    page,
    request,
  }) => {
    const cookie = await signedInAs(page, request, "lister");
    await createServerProfile(request, cookie, "Panto 2026");

    await gotoApp(page);
    await openProfileManager(page);
    await page.getByText("Import / Export").click();

    const rows = page.getByTestId("connect-profile-row");
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
    await expect(rows.first()).toContainText("Panto 2026");
    // Each row says where it lives, since one list covers both sources.
    await expect(rows.first().getByTestId("connect-profile-source")).toHaveText(
      "ImpAmp server",
    );
  });

  test("connecting one brings it here and stops offering it again", async ({
    page,
    request,
  }) => {
    const cookie = await signedInAs(page, request, "connector");
    await createServerProfile(request, cookie, "Fringe Tech Run");

    await gotoApp(page);
    await openProfileManager(page);
    await page.getByText("Import / Export").click();

    await page.getByTestId("connect-profile-button").first().click();

    // Offering it again would just make a second copy of a profile that is
    // already syncing here.
    await expect(page.getByTestId("connect-profile-already")).toBeVisible({
      timeout: 20_000,
    });

    const profiles = await page.evaluate(() =>
      (
        window as unknown as {
          __profileStore: {
            getState(): { profiles: Array<Record<string, unknown>> };
          };
        }
      ).__profileStore
        .getState()
        .profiles.map((p) => ({
          name: p.name,
          syncType: p.syncType,
          serverProfileId: p.serverProfileId,
          googleDriveFileId: p.googleDriveFileId,
        })),
    );
    const connected = profiles.find((p) => p.name === "Fringe Tech Run");
    expect(connected?.syncType).toBe("server");
    expect(connected?.serverProfileId).toBeTruthy();
    // The payload carries the owner's Drive ids; a connect must not adopt them.
    expect(connected?.googleDriveFileId ?? null).toBeNull();
  });
});

/**
 * The SSE endpoint, which nothing opened before.
 *
 * `/api/profiles/:id/events` is what replaces Drive's fifteen-minute polling
 * window with about a second, and it is also the reason the app must run as a
 * single instance — the event bus is in-process. Every other spec here works
 * around it: `reloadAndWaitForConflict` deliberately reloads rather than
 * waiting for a push. So the live-collaboration promise rested on a route no
 * test had ever connected to.
 *
 * These go through the browser rather than `request.get`, for two reasons: an
 * APIRequestContext buffers the whole body, and this body does not end for
 * thirty minutes; and `EventSource` is what the client actually uses, so the
 * framing has to be right and not merely present.
 */
test.describe("live change notifications", () => {
  test("streams the current version, then every change after it", async ({
    page,
    request,
  }) => {
    const cookie = await signedInAs(page, request, "sse-owner");
    const id = await createServerProfile(request, cookie, "Live Board");

    // Same origin, and a document to run in. Nothing about the page matters.
    await gotoApp(page);

    const opened = await page.evaluate(async (profileId) => {
      const events: string[] = [];
      const source = new EventSource(`/api/profiles/${profileId}/events`);
      (window as unknown as { __sse: string[] }).__sse = events;
      (window as unknown as { __sseClose: () => void }).__sseClose = () =>
        source.close();
      source.addEventListener("change", (event) => {
        events.push((event as MessageEvent<string>).data);
      });
      return new Promise<string>((resolve, reject) => {
        source.addEventListener("change", function first(event) {
          source.removeEventListener("change", first);
          resolve((event as MessageEvent<string>).data);
        });
        source.addEventListener("error", () => reject(new Error("sse error")));
      });
    }, id);

    // The first frame arrives without anything having changed: a client that
    // connects mid-session learns where the server is rather than waiting for
    // the next write to find out.
    expect(JSON.parse(opened)).toEqual({ profileId: id, version: 1 });

    const written = await request.put(`/api/profiles/${id}`, {
      headers: { ...cookie, "if-match": '"1"' },
      data: { name: "Live Board", data: { ...SAMPLE, pushed: true } },
    });
    expect(written.status()).toBe(200);

    // Pushed, not polled: the only thing that happened between the two reads
    // is a write by a different client.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (window as unknown as { __sse: string[] }).__sse.length,
          ),
        { message: "the write should have been announced on the open stream" },
      )
      .toBeGreaterThan(1);

    const all = await page.evaluate(
      () => (window as unknown as { __sse: string[] }).__sse,
    );
    expect(JSON.parse(all[all.length - 1])).toEqual({
      profileId: id,
      version: 2,
    });

    // The payload carries the version and never the data — one code path reads
    // a profile, so an event cannot deliver stale bytes.
    expect(Object.keys(JSON.parse(all[all.length - 1])).sort()).toEqual([
      "profileId",
      "version",
    ]);

    await page.evaluate(() =>
      (window as unknown as { __sseClose: () => void }).__sseClose(),
    );
  });

  test("is a stream, and is closed to callers with no grant", async ({
    page,
    request,
  }) => {
    const cookie = await signedInAs(page, request, "sse-headers");
    const id = await createServerProfile(request, cookie, "Framed");
    await gotoApp(page);

    // Read exactly one chunk and hang up, which is the only way to see the
    // headers of a body that would otherwise run for half an hour.
    const framing = await page.evaluate(async (profileId) => {
      const controller = new AbortController();
      const response = await fetch(`/api/profiles/${profileId}/events`, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const { value } = await reader.read();
      controller.abort();
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        buffering: response.headers.get("x-accel-buffering"),
        chunk: new TextDecoder().decode(value),
      };
    }, id);

    expect(framing.status).toBe(200);
    expect(framing.contentType).toBe("text/event-stream");
    // A proxy that buffers or a cache that stores turns a push into nothing.
    expect(framing.cacheControl).toContain("no-cache");
    expect(framing.buffering).toBe("no");
    expect(framing.chunk).toMatch(/^event: change\ndata: \{.*\}\n\n$/);

    // A stranger gets the same 404 the read route gives, so the stream cannot
    // be used to confirm a profile id either.
    const { token: stranger } = await mintSession(request, "sse-stranger");
    const refused = await request.get(`/api/profiles/${id}/events`, {
      headers: { cookie: `${SESSION_COOKIE}=${stranger}` },
    });
    expect(refused.status()).toBe(404);
    expect((await request.get(`/api/profiles/${id}/events`)).status()).toBe(
      404,
    );
  });
});

/**
 * Following holds the push back, against the real server.
 *
 * The unit tests cover the decision; this covers the promise. A follower that
 * still writes is the failure the feature exists to prevent, and it is visible
 * from outside: the profile's version on the server stops moving.
 */
test.describe("a follower does not write", () => {
  async function seedAndConnect(
    page: Page,
    request: APIRequestContext,
    cookie: { cookie: string },
    followOnly: boolean,
  ) {
    const id = await createServerProfile(request, cookie, "Watched Board");
    const now = Date.now();

    await gotoApp(page);
    await seedActiveProfileSync(page, {
      syncType: "server",
      serverProfileId: id,
      serverRole: "owner",
      audioLocation: "server",
      followOnly,
      // A local edit worth pushing, if we were going to push.
      name: `Edited locally ${now}`,
    });
    return id as string;
  }

  const versionOf = async (
    request: APIRequestContext,
    cookie: { cookie: string },
    id: string,
  ) =>
    (
      await (
        await request.get(`/api/profiles/${id}`, { headers: cookie })
      ).json()
    ).version as number;

  test("leaves the server version alone while following", async ({
    page,
    request,
  }) => {
    const cookie = await signedInAs(page, request, "follower");

    const id = await seedAndConnect(page, request, cookie, true);
    const before = await versionOf(request, cookie, id);

    await page.reload();
    await waitForAppReady(page);

    // Wait for evidence that a sync *completed* rather than for a fixed
    // interval. `serverVersion` is unset until one does — it is written in the
    // same step that decides not to push — so polling for it rules out the
    // reading this test exists to avoid: passing because nothing ran.
    await expect
      .poll(async () => (await readActiveProfile(page)).serverVersion, {
        timeout: 20_000,
      })
      .toBe(before);

    expect(
      await versionOf(request, cookie, id),
      "a follower must not write, even to a profile it owns",
    ).toBe(before);
  });

  test("writes as usual when nobody is following", async ({
    page,
    request,
  }) => {
    // The control: without this, the test above would pass on a sync that
    // never ran.
    const cookie = await signedInAs(page, request, "contributor");

    const id = await seedAndConnect(page, request, cookie, false);
    const before = await versionOf(request, cookie, id);

    await page.reload();
    await waitForAppReady(page);

    await expect
      .poll(() => versionOf(request, cookie, id), { timeout: 20_000 })
      .toBeGreaterThan(before);
  });
});

/**
 * Signing in with Google establishes a session on this server as a side effect
 * of the same code exchange, so anyone using Drive sync had an account here and
 * was never told. `signOutOfServer` existed and was called from nowhere, so
 * "Sign Out" ended the Google session and left the server cookie in place.
 */
test.describe("the server account", () => {
  test("says who you are here, and lets you leave", async ({
    page,
    request,
  }) => {
    const { token, email } = await mintSession(request, "account");
    await signIn(page, token);
    await gotoApp(page);
    await openProfileManager(page);
    await page.getByText("Import / Export").click();

    const account = page.getByTestId("server-account");
    await expect(account).toContainText(email);
    // The link to the storage page, which nothing in the app pointed at.
    await expect(page.getByTestId("server-storage-link")).toBeVisible();

    await page.getByTestId("server-sign-out").click();

    await expect(account).toContainText(/No account/i);
    // Really gone, not just hidden: the session cookie no longer authenticates.
    await expect
      .poll(async () => (await request.get("/api/auth/session")).status(), {
        timeout: 10_000,
      })
      .toBe(401);
  });

  test("signing out reaches the profile cards, not just the account panel", async ({
    page,
    request,
  }) => {
    // `refreshSession` used to update only the instance that called it, and
    // the account panel is the only caller. Every card went on believing it
    // was signed in, so the server option stayed enabled and the scheduled
    // syncs and SSE streams kept firing against a dead cookie until a reload.
    await signIn(page, (await mintSession(request, "cards")).token);
    await gotoApp(page);
    await openProfileManager(page);

    await page.getByTestId("sync-status-chip").first().click();
    const serverOption = page
      .getByTestId("sync-target-server")
      .getByRole("radio");
    await expect(serverOption).toBeEnabled();

    await page.getByText("Import / Export").click();
    await page.getByTestId("server-sign-out").click();
    await page.getByText("Profiles", { exact: true }).click();

    await page.getByTestId("sync-status-chip").first().click();
    await expect(serverOption).toBeDisabled();
  });

  test("says plainly when there is no account", async ({ page }) => {
    await gotoApp(page);
    await openProfileManager(page);
    await page.getByText("Import / Export").click();

    await expect(page.getByTestId("server-account")).toContainText(
      /No account/i,
    );
  });
});

/**
 * Hosted audio, against a bucket that really answers HTTP.
 *
 * Everything here used to be asserted only in the negative: the E2E server set
 * no `IMPAMP_S3_*` variables, so the whole feature could be checked for saying
 * "off" and nothing else. The presigned PUT, the commit that charges quota
 * from what the bucket reports, proof of possession and the download URL had
 * no end-to-end exercise at all, and their unit cover ran against a fake in
 * the same process — so nothing established that a URL this server mints is
 * fetchable, that `Content-Length` comes back from the store rather than from
 * the client, or that a Range read returns the bytes the proof compares.
 *
 * `e2e-tests/fake-s3.js` is that bucket now; `e2e-tests/env.js` points the
 * deployment at it. What a deployment with no bucket answers moved to
 * `audio.api.test.ts`, where it is checked route by route.
 */
test.describe("hosted audio", () => {
  /** Distinct bytes per test, so no two tests share a content-addressed key. */
  function uniqueAudio(sizeBytes: number): {
    bytes: Buffer;
    hash: string;
  } {
    const bytes = randomBytes(sizeBytes);
    return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
  }

  const audioFields = (hash: string) => ({
    hash,
    contentType: "audio/wav",
    extension: "wav",
  });

  /** The admin account, which global setup guaranteed exists. */
  async function adminCookie(request: APIRequestContext) {
    const admin = await mintSession(request, "admin", E2E_ADMIN_EMAIL);
    expect(
      admin.isAdmin,
      "global setup should have claimed the admin account",
    ).toBe(true);
    return { cookie: `${SESSION_COOKIE}=${admin.token}` };
  }

  /** A signed-in account an admin has approved for audio hosting. */
  async function approvedAccount(request: APIRequestContext, who: string) {
    const user = await mintSession(request, who);
    const patched = await request.patch(`/api/admin/users/${user.userId}`, {
      headers: await adminCookie(request),
      data: { canUploadAudio: true },
    });
    expect(patched.status()).toBe(200);
    expect((await patched.json()).canUploadAudio).toBe(true);
    return { ...user, cookie: `${SESSION_COOKIE}=${user.token}` };
  }

  test("an approved account uploads to the bucket and reads the same bytes back", async ({
    request,
  }) => {
    const { cookie } = await approvedAccount(request, "uploader");
    const { bytes, hash } = uniqueAudio(4 * 1024);

    const asked = await request.post("/api/audio/upload-url", {
      headers: { cookie },
      data: { ...audioFields(hash), sizeBytes: bytes.byteLength },
    });
    expect(asked.status()).toBe(200);
    const ask = await asked.json();
    expect(ask.alreadyStored).toBe(false);
    // Presigned, and pointing at the bucket rather than at this server: the
    // bytes never pass through the app.
    expect(ask.uploadUrl).toContain("X-Amz-Signature=");
    expect(ask.uploadUrl).toContain(`localhost:${E2E_S3_PORT}/`);

    // Sent as HTML on purpose. The presigned PUT signs only `host`, so the
    // uploader picks this header and the bucket keeps whatever it is told —
    // which is exactly how an approved account could park a page in the
    // bucket and have it served as HTML from the bucket's own origin. What
    // stops that is the download URL pinning the type we recorded, asserted
    // at the end of this test.
    const put = await request.fetch(ask.uploadUrl, {
      method: "PUT",
      data: bytes,
      headers: { "content-type": "text/html" },
    });
    expect(put.status(), "the presigned PUT should be accepted").toBe(200);

    const committed = await request.post("/api/audio/commit", {
      headers: { cookie },
      data: { ...audioFields(hash), name: "e2e.wav" },
    });
    expect(committed.status()).toBe(200);
    const commit = await committed.json();
    expect(commit.sizeBytes).toBe(bytes.byteLength);
    expect(commit.usage.usedBytes).toBe(bytes.byteLength);

    const library = await request.get("/api/audio", { headers: { cookie } });
    expect(library.status()).toBe(200);
    const listed = (await library.json()).files.find(
      (file: { hash: string }) => file.hash === hash,
    );
    expect(listed).toMatchObject({
      name: "e2e.wav",
      sizeBytes: bytes.byteLength,
    });

    const download = await request.get(`/api/audio/${hash}`, {
      headers: { cookie },
    });
    expect(download.status()).toBe(200);
    const { url } = await download.json();

    const fetched = await request.fetch(url);
    expect(fetched.status()).toBe(200);
    // Served as what we recorded, not as the `text/html` the PUT above set.
    expect(fetched.headers()["content-type"]).toBe("audio/wav");
    expect(Buffer.compare(await fetched.body(), bytes)).toBe(0);
  });

  test("charges the size the bucket reports, not the size the client claimed", async ({
    request,
  }) => {
    const { cookie } = await approvedAccount(request, "over-claimer");
    // Asks permission for something small, then PUTs something over the
    // deployment's per-object ceiling. A presigned PUT signs only `host`, so
    // nothing in the URL could have stopped this — the commit is the only
    // place it can be caught.
    const { bytes, hash } = uniqueAudio(40 * 1024);

    const asked = await request.post("/api/audio/upload-url", {
      headers: { cookie },
      data: { ...audioFields(hash), sizeBytes: 1024 },
    });
    expect(asked.status()).toBe(200);
    const ask = await asked.json();

    expect(
      (
        await request.fetch(ask.uploadUrl, {
          method: "PUT",
          data: bytes,
          headers: { "content-type": "audio/wav" },
        })
      ).status(),
    ).toBe(200);

    const committed = await request.post("/api/audio/commit", {
      headers: { cookie },
      data: { ...audioFields(hash), name: "too-big.wav" },
    });
    expect(committed.status()).toBe(413);
    expect((await committed.json()).reason).toBe("too_large");

    // Nothing was charged…
    const usage = await (
      await request.get("/api/audio", { headers: { cookie } })
    ).json();
    expect(usage.usage.usedBytes).toBe(0);
    expect(usage.files).toEqual([]);

    // …and the bytes are gone from the bucket rather than sitting there
    // unaccounted for. A second commit now finds no object at all, which is
    // only true if the refusal deleted it.
    const again = await request.post("/api/audio/commit", {
      headers: { cookie },
      data: { ...audioFields(hash), name: "too-big.wav" },
    });
    expect(again.status()).toBe(404);
  });

  test("makes a second claimant prove it holds the bytes", async ({
    request,
  }) => {
    const first = await approvedAccount(request, "first-holder");
    const second = await approvedAccount(request, "second-holder");
    const { bytes, hash } = uniqueAudio(3 * 1024);

    const ask = await (
      await request.post("/api/audio/upload-url", {
        headers: { cookie: first.cookie },
        data: { ...audioFields(hash), sizeBytes: bytes.byteLength },
      })
    ).json();
    await request.fetch(ask.uploadUrl, {
      method: "PUT",
      data: bytes,
      headers: { "content-type": "audio/wav" },
    });
    expect(
      (
        await request.post("/api/audio/commit", {
          headers: { cookie: first.cookie },
          data: { ...audioFields(hash), name: "shared.wav" },
        })
      ).status(),
    ).toBe(200);

    // The hash is public — it travels in every profile blob a viewer can read
    // — so knowing it must not be enough to be handed a reference to the file.
    const secondAsk = await (
      await request.post("/api/audio/upload-url", {
        headers: { cookie: second.cookie },
        data: { ...audioFields(hash), sizeBytes: bytes.byteLength },
      })
    ).json();
    expect(secondAsk.alreadyStored).toBe(true);
    expect(secondAsk.uploadUrl).toBeNull();
    expect(secondAsk.proofRange).not.toBeNull();

    const withoutProof = await request.post("/api/audio/commit", {
      headers: { cookie: second.cookie },
      data: { ...audioFields(hash), name: "claimed.wav" },
    });
    expect(withoutProof.status()).toBe(403);

    const wrongProof = await request.post("/api/audio/commit", {
      headers: { cookie: second.cookie },
      data: {
        ...audioFields(hash),
        name: "claimed.wav",
        proof: createHash("sha256").update("not the bytes").digest("hex"),
      },
    });
    expect(wrongProof.status()).toBe(403);

    // The range is read out of the bucket over real HTTP, so this is also the
    // only exercise the client's `getRange` gets against a server that
    // actually answers 206.
    const { offset, length } = secondAsk.proofRange;
    const proof = createHash("sha256")
      .update(bytes.subarray(offset, offset + length))
      .digest("hex");

    const withProof = await request.post("/api/audio/commit", {
      headers: { cookie: second.cookie },
      data: { ...audioFields(hash), name: "claimed.wav", proof },
    });
    expect(withProof.status()).toBe(200);
    // Charged to both, because both now hold a reference — but the bucket
    // holds one object.
    expect((await withProof.json()).usage.usedBytes).toBe(bytes.byteLength);
  });

  test("keeps the admin surface invisible to an ordinary account", async ({
    request,
  }) => {
    const ordinary = await mintSession(request, "not-an-admin");
    const cookie = `${SESSION_COOKIE}=${ordinary.token}`;

    // 404 rather than 403, so an ordinary account cannot even learn that an
    // admin surface exists.
    expect(
      (await request.get("/api/admin/audio", { headers: { cookie } })).status(),
    ).toBe(404);

    // Nor approve itself, which is the one thing this boundary is protecting.
    const selfApproval = await request.patch(
      `/api/admin/users/${ordinary.userId}`,
      { headers: { cookie }, data: { canUploadAudio: true } },
    );
    expect(selfApproval.status()).toBe(404);

    const stillRefused = await request.post("/api/audio/upload-url", {
      headers: { cookie },
      data: { ...audioFields("c".repeat(64)), sizeBytes: 1024 },
    });
    expect(stillRefused.status()).toBe(403);
    expect((await stillRefused.json()).reason).toBe("not_approved");

    // And the same account, seen by an admin, is exactly what it says it is.
    const overview = await request.get("/api/admin/audio", {
      headers: await adminCookie(request),
    });
    expect(overview.status()).toBe(200);
    const body = await overview.json();
    expect(body.global.capBytes).toBeGreaterThan(0);
    expect(
      body.users.find(
        (user: { email: string }) => user.email === ordinary.email,
      ),
    ).toMatchObject({ canUploadAudio: false });
  });

  test("the storage page shows an approved account its allowance", async ({
    page,
    request,
  }) => {
    const { token } = await approvedAccount(request, "storage-page");
    await signIn(page, token);
    await page.goto("/server/storage");

    await expect(
      // `level: 1` because the page's own <h1> and AudioStoragePanel's <h3>
      // carry the same text, so the unqualified locator matches two elements
      // and throws Playwright's strict-mode violation — but only once the
      // panel has loaded. Measured at 2 failures in 12 on an idle machine,
      // which is why the suite read green for a whole day.
      page.getByRole("heading", { level: 1, name: "Server audio storage" }),
    ).toBeVisible();
    // The allowance bar is the one thing on this page that only renders for an
    // account the deployment will actually store audio for.
    await expect(page.getByRole("progressbar").first()).toBeVisible();
  });

  test("the storage page tells an anonymous visitor nothing", async ({
    page,
  }) => {
    await page.goto("/server/storage");
    await expect(
      // `level: 1` because the page's own <h1> and AudioStoragePanel's <h3>
      // carry the same text, so the unqualified locator matches two elements
      // and throws Playwright's strict-mode violation — but only once the
      // panel has loaded. Measured at 2 failures in 12 on an idle machine,
      // which is why the suite read green for a whole day.
      page.getByRole("heading", { level: 1, name: "Server audio storage" }),
    ).toBeVisible();
    // Not signed in, so no allowance and no admin panel — whether or not this
    // deployment hosts audio.
    await expect(page.getByRole("progressbar")).toHaveCount(0);
  });
});

/** Read back the session cookie the browser is carrying. */
async function sessionCookieOf(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === SESSION_COOKIE);
  return `${SESSION_COOKIE}=${session?.value ?? ""}`;
}
