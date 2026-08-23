// @vitest-environment jsdom
/**
 * Service worker registration, and the development branch that is really an
 * *un*registration.
 *
 * The module docstring explains why: a worker is scoped to an origin rather
 * than to a server, and `npm start` and `npm run dev` both default to port
 * 3000, so a production build visited once leaves a cache-first worker sitting
 * on the dev server's origin serving chunk URLs Turbopack has since moved. The
 * only thing standing between a developer and an unexplained stale bundle is
 * that dev actively tears the registration down and drops the `impamp-`
 * caches — and it must drop only those, because the origin is shared with
 * anything else the developer has served from localhost:3000.
 *
 * The `whenLoaded` gate has the same shape as every "add a listener" bug in
 * this repo: a React effect frequently runs *after* `load` has already fired,
 * and a listener added then never runs at all, so the registration silently
 * never happens. The `readyState === "complete"` check is what makes it fire
 * anyway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const register = vi.fn(
  async () => ({ waiting: null }) as ServiceWorkerRegistration,
);
const getRegistrations = vi.fn(async () => [] as ServiceWorkerRegistration[]);
const cacheKeys = vi.fn(async () => [] as string[]);
const cacheDelete = vi.fn(async () => true);

/** A registration whose only interesting property is whether it unregisters. */
function fakeRegistration() {
  return {
    unregister: vi.fn(async () => true),
  } as unknown as ServiceWorkerRegistration & {
    unregister: ReturnType<typeof vi.fn>;
  };
}

/**
 * Installs `navigator.serviceWorker` and `caches`, then imports a fresh copy
 * of the module under the given build mode.
 *
 * `NODE_ENV` is read inside `registerServiceWorker` rather than at module
 * scope, so it could in principle be set per call — but the module is
 * re-imported anyway to keep each case independent of the last.
 *
 * @param nodeEnv - What the build should look like to the module
 * @param options - `serviceWorker: false` removes the API entirely
 * @returns The module's exports
 */
async function loadRegistrar(
  nodeEnv: string,
  { serviceWorker = true, caches: withCaches = true } = {},
): Promise<typeof import("./register")> {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.resetModules();

  if (serviceWorker) {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register, getRegistrations },
    });
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }

  if (withCaches) {
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: { keys: cacheKeys, delete: cacheDelete },
    });
  } else {
    Reflect.deleteProperty(window, "caches");
  }

  return import("./register");
}

/** Puts the document in the state a page still loading would be in. */
function pretendStillLoading(): void {
  vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  register.mockReset();
  register.mockResolvedValue({ waiting: null } as ServiceWorkerRegistration);
  getRegistrations.mockReset();
  getRegistrations.mockResolvedValue([]);
  cacheKeys.mockReset();
  cacheKeys.mockResolvedValue([]);
  cacheDelete.mockReset();
  cacheDelete.mockResolvedValue(true);
});

describe("in production", () => {
  it("registers a URL carrying the build id, so a redeploy is a new script", async () => {
    const { registerServiceWorker } = await loadRegistrar("production");

    registerServiceWorker();

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    const [url] = register.mock.calls[0] as unknown as [string];
    expect(url.startsWith("/sw.js?build=")).toBe(true);
    expect(url.length).toBeGreaterThan("/sw.js?build=".length);
  });

  it("never unregisters or clears caches", async () => {
    const { registerServiceWorker } = await loadRegistrar("production");

    registerServiceWorker();

    await vi.waitFor(() => expect(register).toHaveBeenCalled());
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(cacheKeys).not.toHaveBeenCalled();
  });

  it("waits for load rather than competing with the app's own startup", async () => {
    pretendStillLoading();
    const { registerServiceWorker } = await loadRegistrar("production");

    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("load"));

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
  });

  it("registers anyway when load has already fired", async () => {
    // A React effect routinely runs after `load`; a listener added then never
    // runs, and the worker would silently never be installed.
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    const { registerServiceWorker } = await loadRegistrar("production");

    registerServiceWorker();

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
  });

  it("notes a waiting worker without reloading the page", async () => {
    register.mockResolvedValue({
      waiting: {},
    } as unknown as ServiceWorkerRegistration);
    const { registerServiceWorker } = await loadRegistrar("production");

    registerServiceWorker();

    await vi.waitFor(() =>
      expect(console.info).toHaveBeenCalledWith(
        expect.stringContaining("next launch"),
      ),
    );
  });

  it("warns rather than rejecting when registration fails", async () => {
    // An unregistered worker only costs offline support, so this must never
    // reach the page as an unhandled rejection.
    register.mockRejectedValue(new Error("insecure origin"));
    const { registerServiceWorker } = await loadRegistrar("production");

    registerServiceWorker();

    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        "Service worker registration failed:",
        expect.any(Error),
      ),
    );
  });
});

describe("in development", () => {
  it("unregisters every worker instead of adding one", async () => {
    const stale = fakeRegistration();
    getRegistrations.mockResolvedValue([stale]);
    const { registerServiceWorker } = await loadRegistrar("development");

    registerServiceWorker();

    await vi.waitFor(() => expect(stale.unregister).toHaveBeenCalledTimes(1));
    expect(register).not.toHaveBeenCalled();
  });

  it("drops only this app's caches, not everything on the origin", async () => {
    cacheKeys.mockResolvedValue([
      "impamp-shell-v3",
      "impamp-audio",
      "some-other-app",
    ]);
    const { registerServiceWorker } = await loadRegistrar("development");

    registerServiceWorker();

    await vi.waitFor(() => expect(cacheDelete).toHaveBeenCalledTimes(2));
    expect(cacheDelete.mock.calls.flat()).toEqual([
      "impamp-shell-v3",
      "impamp-audio",
    ]);
  });

  it("skips the cache sweep where the CacheStorage API is absent", async () => {
    const { registerServiceWorker } = await loadRegistrar("development", {
      caches: false,
    });

    registerServiceWorker();

    await vi.waitFor(() => expect(getRegistrations).toHaveBeenCalled());
    expect(cacheKeys).not.toHaveBeenCalled();
  });

  it("warns rather than rejecting when the teardown fails", async () => {
    getRegistrations.mockRejectedValue(new Error("no permission"));
    const { registerServiceWorker } = await loadRegistrar("development");

    registerServiceWorker();

    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        "Could not clear the development service worker:",
        expect.any(Error),
      ),
    );
  });
});

describe("where there is no service worker API", () => {
  it("does nothing at all, in either build mode", async () => {
    const dev = await loadRegistrar("development", { serviceWorker: false });
    dev.registerServiceWorker();

    const prod = await loadRegistrar("production", { serviceWorker: false });
    prod.registerServiceWorker();

    expect(register).not.toHaveBeenCalled();
    expect(getRegistrations).not.toHaveBeenCalled();
  });
});
