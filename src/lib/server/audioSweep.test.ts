/**
 * The sweep that removes bucket objects nobody ever committed.
 *
 * Those bytes are otherwise unreachable forever: no `audio_objects` row means
 * no quota counts them, the admin view sums that table so it cannot show them,
 * and no API can delete them — while Wasabi bills a 90-day minimum for each.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, queryAll } from "./db";
import { upsertUserFromGoogle } from "./users";
import { recordPendingUpload, recordUpload } from "./audio";
import {
  ensureSweepScheduled,
  MIN_SWEEP_INTERVAL_MS,
  sweepIfDue,
  sweepIsScheduledForTests,
  resetSweepScheduleForTests,
} from "./audioSweep";
import { sweepUncommittedObjects } from "./audioSweep";
import { resolveObjectStore, setObjectStoreForTests } from "./audioRequests";
import { objectKeyForHash } from "./s3/client";
import {
  createFakeObjectStore,
  type FakeObjectStore,
} from "./s3/fakeObjectStore";
import type { AudioHostingConfig } from "./s3/config";

const KB = 1024;
const HOUR = 60 * 60 * 1000;

const config: AudioHostingConfig = {
  endpoint: "https://s3.test.example",
  region: "eu-central-2",
  bucket: "impamp-audio",
  accessKeyId: "key",
  secretAccessKey: "secret",
  globalCapBytes: 100 * KB,
  defaultUserQuotaBytes: 10 * KB,
  uploadUrlTtlSeconds: 900,
  downloadUrlTtlSeconds: 300,
  maxObjectBytes: 8 * KB,
};

let store: FakeObjectStore;
const NOW = 1_800_000_000_000;

/** Well past uploadUrlTtlSeconds plus the extra hour of grace. */
const LONG_AGO = NOW - 6 * HOUR;

const hash = (n: number) => String(n).repeat(64).slice(0, 64);

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
  store = createFakeObjectStore();
  resetSweepScheduleForTests();
});

/** An object in the bucket with a matching audio_objects row. */
function committed(n: number, at = LONG_AGO): string {
  const user = upsertUserFromGoogle({
    sub: `sub-${n}`,
    email: `user${n}@example.com`,
    name: null,
    picture: null,
  });
  const key = objectKeyForHash(hash(n), "wav");
  store.put(key, KB);
  store.setLastModified(key, at);
  recordUpload({
    userId: user.id,
    hash: hash(n),
    sizeBytes: KB,
    contentType: "audio/wav",
    extension: "wav",
    name: `sound-${n}.wav`,
  });
  return key;
}

/** An object the browser PUT and never committed. */
function orphan(n: number, at = LONG_AGO): string {
  const key = objectKeyForHash(hash(n), "wav");
  store.put(key, KB);
  store.setLastModified(key, at);
  return key;
}

const sweep = () => sweepUncommittedObjects({ store, config, now: NOW });

describe("sweepUncommittedObjects", () => {
  it("removes an object with no audio_objects row", async () => {
    orphan(1);

    expect(await sweep()).toMatchObject({ scanned: 1, removed: 1 });
    expect(store.keys()).toEqual([]);
  });

  it("keeps an object that was committed", async () => {
    const key = committed(2);

    expect(await sweep()).toMatchObject({ scanned: 1, removed: 0 });
    expect(store.keys()).toEqual([key]);
  });

  it("keeps a recent orphan, because its commit may still be arriving", async () => {
    // The presigned PUT is valid for uploadUrlTtlSeconds, so an upload can
    // still be in flight. Deleting a file out from under someone mid-upload is
    // a worse failure than paying for it for another hour.
    const key = orphan(3, NOW - 60_000);

    expect(await sweep()).toMatchObject({ scanned: 1, removed: 0 });
    expect(store.keys()).toEqual([key]);
  });

  it("leaves alone any key it does not recognise as one of ours", async () => {
    // A sweep that deletes keys it cannot parse is a sweep that eats whatever
    // else the bucket is used for.
    store.put("audio/zz/not-a-hash.wav", KB);
    store.setLastModified("audio/zz/not-a-hash.wav", LONG_AGO);

    expect(await sweep()).toMatchObject({ removed: 0 });
    expect(store.keys()).toEqual(["audio/zz/not-a-hash.wav"]);
  });

  it("sorts one bucket of mixed objects correctly in a single pass", async () => {
    const kept = committed(4);
    orphan(5);
    orphan(6);
    const recent = orphan(7, NOW - 60_000);

    expect(await sweep()).toMatchObject({ scanned: 4, removed: 2 });
    expect(store.keys().sort()).toEqual([kept, recent].sort());
  });
});

describe("sweepIfDue", () => {
  it("runs the first time it is asked", async () => {
    orphan(8);
    expect(await sweepIfDue({ store, config }, NOW)).toMatchObject({
      removed: 1,
    });
  });

  it("does not run again within the hour", async () => {
    await sweepIfDue({ store, config }, NOW);
    orphan(9);

    expect(await sweepIfDue({ store, config }, NOW + 60_000)).toBeNull();
    expect(store.keys()).toHaveLength(1);
  });

  it("runs again once the interval has passed", async () => {
    await sweepIfDue({ store, config }, NOW);
    orphan(9, NOW - 6 * HOUR);

    expect(await sweepIfDue({ store, config }, NOW + 2 * HOUR)).toMatchObject({
      removed: 1,
    });
  });

  it("reports null rather than throwing when the bucket is unreachable", async () => {
    // This hangs off the admin page. A bucket that is down must not take the
    // one view of storage down with it.
    const broken = {
      ...store,
      list: async () => {
        throw new Error("bucket unreachable");
      },
    };

    expect(await sweepIfDue({ store: broken, config }, NOW)).toBeNull();
  });
});

describe("the periodic sweep", () => {
  afterEach(() => {
    resetSweepScheduleForTests();
    vi.useRealTimers();
  });

  it("runs without an admin looking at the storage page", async () => {
    // The only thing that swept was the admin audio route, so uncommitted
    // bytes were reclaimed when somebody happened to open a page — which on a
    // working deployment is approximately never, while Wasabi bills a 90-day
    // minimum for each object.
    vi.useFakeTimers();
    const key = orphan(10, Date.now() - 6 * HOUR);

    ensureSweepScheduled({ store, config });
    expect(store.keys()).toEqual([key]);

    await vi.advanceTimersByTimeAsync(MIN_SWEEP_INTERVAL_MS + 1000);

    expect(store.keys()).toEqual([]);
  });

  it("is started by the first hosted-audio request of the process", async () => {
    // There is no startup hook to hang it off, and a deployment nobody uses
    // has nothing to sweep, so the store resolver is where it begins.
    setObjectStoreForTests(null);
    const vars = {
      IMPAMP_S3_ENDPOINT: "https://s3.example.invalid",
      IMPAMP_S3_REGION: "eu-central-2",
      IMPAMP_S3_BUCKET: "impamp-audio",
      IMPAMP_S3_ACCESS_KEY_ID: "key",
      IMPAMP_S3_SECRET_ACCESS_KEY: "secret",
    };
    Object.assign(process.env, vars);
    try {
      expect(sweepIsScheduledForTests()).toBe(false);

      expect(resolveObjectStore()).not.toBeNull();

      expect(sweepIsScheduledForTests()).toBe(true);
    } finally {
      for (const name of Object.keys(vars)) delete process.env[name];
    }
  });

  it("forgets a mint whose upload URL has expired", async () => {
    // The upload path prunes as it goes, which covers everyone who comes back.
    // This covers whoever does not.
    const user = upsertUserFromGoogle({
      sub: "sub-pending",
      email: "pending@example.com",
      name: null,
      picture: null,
    });
    recordPendingUpload({
      userId: user.id,
      hash: hash(11),
      sizeBytes: KB,
      now: LONG_AGO,
    });

    await sweep();

    expect(queryAll("SELECT 1 FROM audio_pending_uploads")).toHaveLength(0);
  });
});
