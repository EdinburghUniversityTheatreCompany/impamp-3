import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { E2E_SIGNIN_SECRET } from "../playwright.config";
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
): Promise<{ token: string; email: string }> {
  const email = `${who}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const response = await request.post("/api/test/session", {
    headers: { "x-impamp-e2e-secret": E2E_SIGNIN_SECRET },
    data: { email },
  });
  expect(
    response.status(),
    "test sign-in route should be enabled during E2E",
  ).toBe(200);
  return { token: (await response.json()).token as string, email };
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
 * Hosted audio is opt-in infrastructure: the E2E server sets no IMPAMP_S3_*
 * variables, so this asserts the promise that a deployment which configures
 * nothing hosts nothing — and says so rather than half-working.
 */
test.describe("hosted audio, unconfigured", () => {
  test("every audio route reports the feature is off", async ({
    page,
    request,
  }) => {
    const { token } = await mintSession(request, "audio-off");
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
