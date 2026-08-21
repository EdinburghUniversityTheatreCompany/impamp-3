/**
 * What a freshly opened change stream is allowed to set off.
 *
 * The server greets every connection with a `change` event carrying the
 * profile's current version — deliberately, so a client that missed a bump
 * while disconnected still converges. But a stream started with
 * `reportedVersion = 0` treats that greeting as news whatever it says, so
 * every connect ran a full pull/merge for a version the device already had.
 *
 * That is not once. It is every page load, and again whenever a profile is
 * re-linked or its share token rotated, for every server-synced profile —
 * immediately after the load-time sync of the same profiles has just run.
 *
 * The push half of this is already closed: `describesSameSyncState` stops a
 * sync that changed nothing from writing. The work is not. Each spurious
 * trigger still reads the whole local profile — every pad, every bank, every
 * audio record's metadata — and merges it against the remote before deciding
 * there is nothing to say.
 *
 * The stream therefore starts from what this device already holds rather than
 * from zero. It reads that from the store instead of taking it as an argument
 * so that a caller cannot forget it, or pass one that has gone stale.
 */
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/db";

/** Just enough EventSource for the subscription under test. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, Set<EventListener>>();
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: EventListener) {
    (
      this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!
    ).add(listener);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  /** What the server sends: a `change` event carrying a version. */
  announce(payload: Record<string, unknown>) {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    this.listeners.get("change")?.forEach((listener) => {
      (listener as (e: MessageEvent) => void)(event);
    });
  }
}

const { useProfileStore } = await import("@/store/profileStore");
const { subscribeToProfileChanges } = await import("@/hooks/useServerSync");
const { ORIGIN_ID } = await import("@/lib/serverSync/api");

const SERVER_ID = "srv-1";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    name: "Panto",
    syncType: "server",
    serverProfileId: SERVER_ID,
    lastBackedUpAt: 0,
    backupReminderPeriod: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Profile;
}

let teardown: (() => void) | undefined;

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(async () => {
  teardown?.();
  teardown = undefined;
  vi.unstubAllGlobals();
  await clearAllStores();
});

/** Opens a stream for a profile in the given state, and returns the changes. */
function streamFor(p: Profile): number[] {
  useProfileStore.setState({ profiles: [p] });
  const seen: number[] = [];
  teardown = subscribeToProfileChanges(SERVER_ID, null, (v) => seen.push(v));
  return seen;
}

describe("a change stream opening", () => {
  it("ignores a greeting for the version this device already has", () => {
    const seen = streamFor(profile({ serverVersion: 5 }));

    FakeEventSource.last!.announce({ version: 5 });

    expect(seen).toEqual([]);
  });

  it("ignores a greeting for a version older than this device's", () => {
    // The stream can outlive a sync that moved us forward, and a reconnect
    // then re-greets at whatever the server said when it accepted us.
    const seen = streamFor(profile({ serverVersion: 7 }));

    FakeEventSource.last!.announce({ version: 6 });

    expect(seen).toEqual([]);
  });

  it("still acts on a version the device has not seen", () => {
    const seen = streamFor(profile({ serverVersion: 5 }));

    FakeEventSource.last!.announce({ version: 5 });
    FakeEventSource.last!.announce({ version: 6 });

    expect(seen).toEqual([6]);
  });

  it("acts on the greeting when this device has never pulled", () => {
    // No `serverVersion` at all: the profile was adopted elsewhere, or linked
    // and not yet synced. The greeting is the first thing it has heard.
    const seen = streamFor(profile({ serverVersion: undefined }));

    FakeEventSource.last!.announce({ version: 3 });

    expect(seen).toEqual([3]);
  });

  it("acts on the greeting for a profile it cannot find in the store", () => {
    // Nothing is known about it, so nothing may be assumed about it.
    useProfileStore.setState({ profiles: [] });
    const seen: number[] = [];
    teardown = subscribeToProfileChanges(SERVER_ID, null, (v) => seen.push(v));

    FakeEventSource.last!.announce({ version: 2 });

    expect(seen).toEqual([2]);
  });

  it("ignores the echo of this device's own write", () => {
    const seen = streamFor(profile({ serverVersion: 5 }));

    FakeEventSource.last!.announce({ version: 9, originId: ORIGIN_ID });

    expect(seen).toEqual([]);
  });

  it("survives a malformed event", () => {
    const seen = streamFor(profile({ serverVersion: 5 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const listener = [...FakeEventSource.last!.listeners.get("change")!][0];
    (listener as (e: MessageEvent) => void)({
      data: "not json",
    } as MessageEvent);
    FakeEventSource.last!.announce({ version: 6 });

    expect(seen).toEqual([6]);
    warn.mockRestore();
  });
});
