/**
 * The sweep that removes bucket objects nobody ever committed.
 *
 * Those bytes are otherwise unreachable forever: no `audio_objects` row means
 * no quota counts them, the admin view sums that table so it cannot show them,
 * and no API can delete them — while Wasabi bills a 90-day minimum for each.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AddressInfo } from "node:net";
import { closeDb, getDb, queryAll } from "./db";
import { upsertUserFromGoogle } from "./users";
import { recordPendingUpload, recordUpload } from "./audio";
import {
  ensureSweepScheduled,
  MIN_SWEEP_INTERVAL_MS,
  sweepIfDue,
  sweepIsScheduledForTests,
  resetSweepScheduleForTests,
  type SweepLimits,
} from "./audioSweep";
import { sweepUncommittedObjects } from "./audioSweep";
import { resolveObjectStore, setObjectStoreForTests } from "./audioRequests";
import { createObjectStore, objectKeyForHash } from "./s3/client";
// The bucket the E2E run uses: real HTTP, real ListObjectsV2 with continuation
// tokens. Borrowed rather than restated, so the pagination this module now
// depends on is exercised against something that answers over the wire.
import { createFakeS3Server } from "../../../e2e-tests/fake-s3.js";
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

/** The audio_objects row that makes an object a committed one. */
function commitRow(n: number): string {
  const user = upsertUserFromGoogle({
    sub: `sub-${n}`,
    email: `user${n}@example.com`,
    name: null,
    picture: null,
  });
  recordUpload({
    userId: user.id,
    hash: hash(n),
    sizeBytes: KB,
    contentType: "audio/wav",
    extension: "wav",
    name: `sound-${n}.wav`,
  });
  return objectKeyForHash(hash(n), "wav");
}

/** An object in the bucket with a matching audio_objects row. */
function committed(n: number, at = LONG_AGO): string {
  const key = commitRow(n);
  store.put(key, KB);
  store.setLastModified(key, at);
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

/**
 * Small enough to build in a test, and the same shape as the production
 * numbers: a budget of several pages, so both halves of the traversal — the
 * continuation token within a pass and the resume key across passes — get
 * used.
 */
const SMALL: SweepLimits = { maxScanned: 4, listPageSize: 2, maxRemoved: 100 };

describe("walking a bucket bigger than one pass", () => {
  /** One pass over the fake bucket, on the small limits above. */
  const pass = (limits: SweepLimits = SMALL) =>
    sweepUncommittedObjects({ store, config, now: NOW, limits });

  // `continuationToken` was a local, so every pass restarted at the top of the
  // listing and the scan cap stopped it in the same place. Committed objects
  // count against that cap, so any bucket with a real library in it hid
  // everything sorting behind the first `maxScanned` keys — permanently, from
  // the only mechanism that can delete an uncommitted object at all.
  it("reaches an orphan sorting behind more committed objects than one pass sees", async () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) committed(n);
    const junk = orphan(9);

    expect(await pass()).toEqual({ scanned: 4, removed: 0, truncated: true });
    expect(store.keys()).toContain(junk);

    expect(await pass()).toEqual({ scanned: 4, removed: 0, truncated: true });
    expect(store.keys()).toContain(junk);

    expect(await pass()).toEqual({ scanned: 1, removed: 1, truncated: false });
    expect(store.keys()).not.toContain(junk);
  });

  it("starts over from the top once it has reached the end of the listing", async () => {
    // Otherwise the cursor is a one-way trip: everything behind it is swept
    // once and nothing ever uploaded in front of it is looked at again. The
    // first pass has to end truncated for this to mean anything — a bucket
    // small enough to finish in one pass leaves the cursor at null either way,
    // which is how the first version of this test passed with the reset
    // removed.
    for (const n of [1, 2, 3, 4, 5]) committed(n);

    expect(await pass()).toEqual({ scanned: 4, removed: 0, truncated: true });
    expect(await pass()).toEqual({ scanned: 1, removed: 0, truncated: false });

    const junk = orphan(0);

    expect(await pass()).toEqual({ scanned: 4, removed: 1, truncated: true });
    expect(store.keys()).not.toContain(junk);
  });

  it("resumes after the object it was deleting when it hit the removal cap", async () => {
    // The early return at the removal cap had the same shape as the scan cap:
    // it left with nothing recorded, so the next pass re-examined everything
    // in front of it. The recent orphan is what makes that visible — it stays
    // in the bucket, so a pass that started over would count it again.
    orphan(1, NOW - 60_000);
    orphan(2);
    committed(3);
    const limits: SweepLimits = { ...SMALL, maxScanned: 100, maxRemoved: 1 };

    expect(await pass(limits)).toEqual({
      scanned: 2,
      removed: 1,
      truncated: true,
    });
    expect(await pass(limits)).toEqual({
      scanned: 1,
      removed: 0,
      truncated: false,
    });
  });
});

describe("walking a bucket that answers over HTTP", () => {
  // Everything above runs against an in-process fake, which is the same code
  // deciding what a page is and what a continuation token means. This one goes
  // through `createObjectStore` — signed requests, a real ListObjectsV2
  // document, real `NextContinuationToken` and `start-after` query parameters
  // — against the bucket the E2E run uses.
  let server: ReturnType<typeof createFakeS3Server>;
  let httpConfig: AudioHostingConfig;

  beforeAll(async () => {
    server = createFakeS3Server();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    httpConfig = { ...config, endpoint: `http://127.0.0.1:${port}` };
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it("pages through the listing and resumes where the last pass stopped", async () => {
    const httpStore = createObjectStore(httpConfig);
    // The bucket stamps every PUT with the moment it arrived, so the passes
    // run from ten days later rather than backdating the objects.
    const now = Date.now() + 10 * 24 * 60 * 60 * 1000;
    const put = async (key: string) => {
      const response = await fetch(httpStore.presignUpload(key), {
        method: "PUT",
        body: new Uint8Array(KB),
      });
      expect(response.ok).toBe(true);
    };

    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await put(commitRow(n));
    const junk = objectKeyForHash(hash(9), "wav");
    await put(junk);

    const pass = () =>
      sweepUncommittedObjects({
        store: httpStore,
        config: httpConfig,
        now,
        limits: SMALL,
      });

    expect(await pass()).toEqual({ scanned: 4, removed: 0, truncated: true });
    expect(await pass()).toEqual({ scanned: 4, removed: 0, truncated: true });
    expect(await pass()).toEqual({ scanned: 1, removed: 1, truncated: false });

    expect(await httpStore.head(junk)).toBeNull();
    expect(
      (await httpStore.list({ prefix: "audio/", maxKeys: 100 })).objects,
    ).toHaveLength(8);
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
