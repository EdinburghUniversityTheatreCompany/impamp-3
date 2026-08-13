import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "./db";
import { upsertUserFromGoogle } from "./users";
import {
  createSession,
  destroySession,
  getSessionUser,
  sessionCookieOptions,
  SESSION_TTL_MS,
} from "./session";
import {
  publishProfileChange,
  subscribeToProfile,
  watcherCount,
} from "./events";

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
});

const makeUser = () =>
  upsertUserFromGoogle({
    sub: "sub-1",
    email: "user@example.com",
    name: "User",
    picture: null,
  });

describe("sessions", () => {
  it("resolves a freshly minted token to its user", () => {
    const user = makeUser();
    const token = createSession(user.id);

    expect(getSessionUser(token)?.id).toBe(user.id);
  });

  it("stores only a hash, never the token itself", () => {
    const user = makeUser();
    const token = createSession(user.id);

    const rows = getDb().prepare("SELECT token_hash FROM sessions").all() as {
      token_hash: string;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an unknown or absent token", () => {
    makeUser();
    expect(getSessionUser("not-a-real-token")).toBeNull();
    expect(getSessionUser(undefined)).toBeNull();
  });

  it("rejects an expired session and clears it", () => {
    const user = makeUser();
    const token = createSession(user.id);

    // Jump past the TTL rather than waiting 30 days.
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);
    try {
      expect(getSessionUser(token)).toBeNull();
      const remaining = getDb()
        .prepare("SELECT COUNT(*) AS count FROM sessions")
        .get() as { count: number };
      expect(remaining.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops working once destroyed", () => {
    const user = makeUser();
    const token = createSession(user.id);

    destroySession(token);
    expect(getSessionUser(token)).toBeNull();
  });

  it("disappears with its user", () => {
    const user = makeUser();
    const token = createSession(user.id);

    getDb().prepare("DELETE FROM users WHERE id = ?").run(user.id);
    expect(getSessionUser(token)).toBeNull();
  });

  it("marks the cookie HttpOnly and same-site", () => {
    const options = sessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
  });
});

describe("profile change events", () => {
  it("delivers a change to every watcher of that profile", () => {
    const seen: number[] = [];
    const unsubA = subscribeToProfile("p1", (c) => seen.push(c.version));
    const unsubB = subscribeToProfile("p1", (c) => seen.push(c.version));

    publishProfileChange({ profileId: "p1", version: 7 });

    expect(seen).toEqual([7, 7]);
    unsubA();
    unsubB();
  });

  it("does not deliver changes for another profile", () => {
    const seen: number[] = [];
    const unsub = subscribeToProfile("p1", (c) => seen.push(c.version));

    publishProfileChange({ profileId: "p2", version: 3 });

    expect(seen).toEqual([]);
    unsub();
  });

  it("stops delivering after unsubscribe and leaves no watcher behind", () => {
    const seen: number[] = [];
    const unsub = subscribeToProfile("p1", (c) => seen.push(c.version));
    unsub();

    publishProfileChange({ profileId: "p1", version: 1 });

    expect(seen).toEqual([]);
    expect(watcherCount("p1")).toBe(0);
  });

  it("keeps notifying the rest when one listener throws", () => {
    const seen: number[] = [];
    const unsubBad = subscribeToProfile("p1", () => {
      throw new Error("this connection is broken");
    });
    const unsubGood = subscribeToProfile("p1", (c) => seen.push(c.version));

    expect(() =>
      publishProfileChange({ profileId: "p1", version: 9 }),
    ).not.toThrow();
    expect(seen).toEqual([9]);

    unsubBad();
    unsubGood();
  });
});
