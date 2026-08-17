import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { E2E_SIGNIN_SECRET } from "../playwright.config";
import {
  activatePad,
  createTestAudioFilePath,
  getActiveSounds,
  gotoApp,
  openProfileManager,
  prepareAudioContext,
  waitForAppReady,
} from "./test-helpers";

/**
 * Offline behaviour.
 *
 * This app is driven live during performances, so the point of the service
 * worker is that losing the venue's wifi does not take the board down. A
 * worker that registers but does not actually survive going offline is exactly
 * the situation these tests exist to rule out, so nothing here asserts on the
 * registration: every test cuts the network for real and then drives the app.
 *
 * They run against a production build, because that is the only build that
 * registers a worker at all — see src/lib/serviceWorker/register.ts.
 */

/**
 * Waits until a service worker is controlling the page.
 *
 * `controller` becomes non-null at `clients.claim()`, which the worker calls
 * from `activate` — and activation only happens after `install` has finished
 * precaching. So this is also the signal that the app shell is fully cached,
 * which is what makes it safe to cut the network on the next line.
 */
async function waitForServiceWorkerControl(page: Page) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
    timeout: 60_000,
  });
}

/**
 * Cuts the network and confirms it is actually cut.
 *
 * The confirmation is not ceremony. Every test in this file passes trivially
 * if the network is still up, so a `setOffline` that was forgotten, misspelt
 * or called on the wrong object turns the whole suite green while proving
 * nothing — which is one keystroke away at all times, and did happen while
 * this file was being written. Asserting `navigator.onLine` here makes that
 * mistake fail loudly in one place instead of silently in three.
 */
async function goOffline(page: Page, context: BrowserContext) {
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
}

/**
 * Signs the browser in to server sync, so `/api/auth/session` answers 200.
 *
 * The /api test needs a *successful* response and not the 401 an anonymous
 * browser gets, because a cache-first handler would refuse to store a 401
 * anyway — so written against 401 the test passed even when the worker was
 * deliberately rewritten to cache everything under /api, which is exactly the
 * thing it exists to forbid. A 200 is the only response that makes it bite.
 *
 * The mechanics are server-sync.spec.ts's: a test-only route that exists only
 * while the suite hands it a secret, because a real sign-in needs a Google
 * account no test can have.
 */
async function signInToServerSync(
  page: Page,
  request: APIRequestContext,
): Promise<void> {
  const response = await request.post("/api/test/session", {
    headers: { "x-impamp-e2e-secret": E2E_SIGNIN_SECRET },
    data: { email: `offline-${Date.now()}@example.com` },
  });
  expect(
    response.status(),
    "test sign-in route should be enabled during E2E",
  ).toBe(200);

  await page.context().addCookies([
    {
      name: "impamp_session",
      value: (await response.json()).token as string,
      domain: "localhost",
      path: "/",
    },
  ]);
}

test.describe("Offline operation", () => {
  test("the board loads, switches banks and plays a pad with no network", async ({
    page,
    context,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const soundName = "offline-cue";
    const audioFilePath = await createTestAudioFilePath(soundName);
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(audioFilePath);

    const firstPad = page.locator('[id^="pad-"]').first();
    await expect(firstPad).toContainText(soundName);

    await waitForServiceWorkerControl(page);

    // From here on there is no network at all: no HTML, no chunks, no fonts,
    // no API. Everything below has to come out of Cache Storage and IndexedDB.
    await goOffline(page, context);
    await page.reload();
    await waitForAppReady(page);
    await prepareAudioContext(page);

    // The app booted from cache rather than from the network.
    expect(
      await page.evaluate(() => !!navigator.serviceWorker.controller),
    ).toBe(true);

    // 1. The board renders.
    await expect(page.locator('[role="tablist"]')).toBeVisible();
    await expect(page.locator('[id^="pad-"]').first()).toContainText(soundName);

    // 2. Bank switching works.
    await page.keyboard.press("2");
    await expect(
      page.locator('[role="tab"][aria-selected="true"]'),
    ).toContainText("Bank 2");
    await page.keyboard.press("1");
    await expect(
      page.locator('[role="tab"][aria-selected="true"]'),
    ).toContainText("Bank 1");

    // 3. A pad still plays its sound. This is the assertion that matters:
    //    sounds live in IndexedDB, so if the shell boots at all they should
    //    play, and if they do not the offline story is worthless.
    await activatePad(page, page.locator('[id^="pad-"]').first());
    const playing = await getActiveSounds(page);
    expect(playing.map((sound) => sound.name)).toContain(soundName);
  });

  test("a screen never opened while online still opens offline", async ({
    page,
    context,
  }) => {
    // The profile manager is a lazily-loaded chunk that this test never
    // fetches while online. It works offline only because the worker walks the
    // asset graph at install time instead of caching what happens to be
    // requested — which is the whole justification for that walk.
    await gotoApp(page);
    await waitForServiceWorkerControl(page);

    await goOffline(page, context);
    await page.reload();
    await waitForAppReady(page);

    await openProfileManager(page);
    await expect(
      page.getByRole("heading", { name: "Profile Manager" }),
    ).toBeVisible();
  });

  test("nothing under /api is ever cached, and offline it fails honestly", async ({
    page,
    context,
    request,
  }) => {
    await signInToServerSync(page, request);
    await gotoApp(page);
    await waitForServiceWorkerControl(page);

    // A successful, cacheable sync response — the kind a careless worker would
    // happily keep. See signInToServerSync for why this must not be the 401 an
    // anonymous browser would get.
    const onlineStatus = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session");
      return response.status;
    });
    expect(onlineStatus).toBe(200);

    // Nothing under /api made it into any cache the app owns.
    const cachedApiUrls = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (new URL(request.url).pathname.startsWith("/api/")) {
            urls.push(request.url);
          }
        }
      }
      return urls;
    });
    expect(cachedApiUrls).toEqual([]);

    // And offline it fails rather than quietly returning the answer it gave a
    // moment ago. A cached sync response could resurrect a deleted profile or
    // mask a failed write, so an error is the correct outcome here, not a
    // degradation to be softened.
    await goOffline(page, context);
    const offlineResult = await page.evaluate(() =>
      fetch("/api/auth/session")
        .then((response) => `status ${response.status}`)
        .catch(() => "network-error"),
    );
    expect(offlineResult).toBe("network-error");

    // And the caches genuinely are populated, so the two assertions above are
    // about /api being excluded rather than about caching never happening.
    const cachedAssetCount = await page.evaluate(async () => {
      const names = await caches.keys();
      let total = 0;
      for (const name of names) {
        const cache = await caches.open(name);
        total += (await cache.keys()).length;
      }
      return total;
    });
    expect(cachedAssetCount).toBeGreaterThan(10);

    await context.setOffline(false);
  });
});
