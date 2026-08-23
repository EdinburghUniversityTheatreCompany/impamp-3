/**
 * How many SSE streams one caller may hold open.
 *
 * A stream is cheap to open and not cheap to hold: the heartbeat re-authorises
 * every 25 seconds, and that is four synchronous SQLite queries on the thread
 * serving every other request. Nothing bounded how many one caller could have,
 * and the endpoint is reachable anonymously — `resolveAccess` grants on a link
 * token, which is a URL that by design circulates. So thousands of streams,
 * from one script, with no account, was a supported thing to do.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/server/db";
import { createSession } from "@/lib/server/session";
import { upsertUserFromGoogle } from "@/lib/server/users";
import { createProfile } from "@/lib/server/profiles";
import { createLinkShare } from "@/lib/server/shares";
import { LIMITS, resetRateLimitState } from "@/lib/server/rateLimit";
import { makeApiRequest, routeParams } from "@/lib/server/testSupport";

import { GET as events } from "./[id]/events/route";

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
  resetRateLimitState();
});

afterEach(() => {
  resetRateLimitState();
});

function owner() {
  const user = upsertUserFromGoogle({
    sub: "sub-1",
    email: "owner@example.com",
    name: "Owner",
    picture: null,
  });
  return { user, token: createSession(user.id) };
}

function aProfile(ownerId: number) {
  return createProfile({
    ownerId,
    name: "Board",
    data: { _syncFormatVersion: 1, padConfigurations: [] },
    serialisedData: JSON.stringify({
      _syncFormatVersion: 1,
      padConfigurations: [],
    }),
  });
}

/**
 * Opens a stream and hands back a way to end it.
 *
 * The response body has to be cancelled rather than left dangling: an
 * abandoned stream holds its slot, which is the whole point of the cap.
 */
async function openStream(
  profileId: string,
  options: { sessionToken?: string; headers?: Record<string, string> },
) {
  const response = await events(
    makeApiRequest(`/api/profiles/${profileId}/events`, options),
    routeParams({ id: profileId }),
  );
  return {
    status: response.status,
    close: () => response.body?.cancel().catch(() => {}),
  };
}

describe("SSE connection cap", () => {
  it("refuses a signed-in caller past the limit", async () => {
    const { user, token } = owner();
    const profile = aProfile(user.id);
    const open: Array<() => unknown> = [];

    for (let i = 0; i < LIMITS.sseStreams; i++) {
      const stream = await openStream(profile.id, { sessionToken: token });
      expect(stream.status).toBe(200);
      open.push(stream.close);
    }

    const refused = await openStream(profile.id, { sessionToken: token });
    expect(refused.status).toBe(429);
    expect(refused.close).toBeDefined();

    open.forEach((close) => close());
  });

  it("gives the slot back when a stream ends", async () => {
    const { user, token } = owner();
    const profile = aProfile(user.id);
    const open: Array<() => unknown> = [];

    for (let i = 0; i < LIMITS.sseStreams; i++) {
      open.push((await openStream(profile.id, { sessionToken: token })).close);
    }
    expect((await openStream(profile.id, { sessionToken: token })).status).toBe(
      429,
    );

    // One watcher closes their tab.
    await open[0]();
    // Give the stream's cancel a turn of the loop to run cleanup.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await openStream(profile.id, { sessionToken: token })).status).toBe(
      200,
    );
    open.slice(1).forEach((close) => close());
  });

  it("counts an anonymous link-share viewer by address", async () => {
    const { user } = owner();
    const profile = aProfile(user.id);
    const share = createLinkShare(profile.id, "viewer", user.id);
    const headers = { "x-forwarded-for": "10.0.0.1, 203.0.113.20" };
    const open: Array<() => unknown> = [];

    for (let i = 0; i < LIMITS.sseStreams; i++) {
      const stream = await events(
        makeApiRequest(`/api/profiles/${profile.id}/events`, {
          headers,
          query: `token=${share.link_token}`,
        }),
        routeParams({ id: profile.id }),
      );
      expect(stream.status).toBe(200);
      open.push(() => stream.body?.cancel().catch(() => {}));
    }

    const refused = await events(
      makeApiRequest(`/api/profiles/${profile.id}/events`, {
        headers,
        query: `token=${share.link_token}`,
      }),
      routeParams({ id: profile.id }),
    );
    expect(refused.status).toBe(429);

    open.forEach((close) => close());
  });

  it("does not pool two accounts into one budget", async () => {
    const first = owner();
    const profile = aProfile(first.user.id);
    const second = upsertUserFromGoogle({
      sub: "sub-2",
      email: "editor@example.com",
      name: "Editor",
      picture: null,
    });
    const secondToken = createSession(second.id);
    const share = createLinkShare(profile.id, "editor", first.user.id);
    const open: Array<() => unknown> = [];

    for (let i = 0; i < LIMITS.sseStreams; i++) {
      open.push(
        (await openStream(profile.id, { sessionToken: first.token })).close,
      );
    }
    expect(
      (await openStream(profile.id, { sessionToken: first.token })).status,
    ).toBe(429);

    // A different person, sharing nothing but the venue's network.
    const other = await events(
      makeApiRequest(`/api/profiles/${profile.id}/events`, {
        sessionToken: secondToken,
        query: `token=${share.link_token}`,
      }),
      routeParams({ id: profile.id }),
    );
    expect(other.status).toBe(200);

    open.forEach((close) => close());
    await other.body?.cancel().catch(() => {});
  });

  it("still refuses an unauthorised caller with 404, not 429", async () => {
    const { user } = owner();
    const profile = aProfile(user.id);

    // The cap must not become a way to learn that a profile exists.
    const stranger = await openStream(profile.id, {});
    expect(stranger.status).toBe(404);
  });
});
