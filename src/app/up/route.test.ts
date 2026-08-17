/**
 * The health check Kamal promotes on.
 *
 * The failure worth catching is not "the app is running" — a constant answers
 * that — but "the volume this app writes to is usable". The deployed
 * `impamp_data` volume was root-owned while the container runs as uid 1000, and
 * because getDb() opens the file lazily on the first request that needs it, /up
 * answered 200 the whole time. It took a human to notice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "@/lib/server/db";
import { GET } from "./route";

let dir: string;
let originalPath: string | undefined;

beforeEach(() => {
  originalPath = process.env.IMPAMP_DB_PATH;
  dir = mkdtempSync(join(tmpdir(), "impamp-health-"));
  closeDb();
});

afterEach(() => {
  closeDb();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
  if (originalPath === undefined) delete process.env.IMPAMP_DB_PATH;
  else process.env.IMPAMP_DB_PATH = originalPath;
  vi.restoreAllMocks();
});

describe("GET /up", () => {
  it("answers 200 when the database is usable", async () => {
    process.env.IMPAMP_DB_PATH = join(dir, "impamp.db");

    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("answers 503 when the volume cannot be written to", () => {
    // Exactly the production failure: the directory exists and is readable, so
    // mkdirSync is a no-op, but the database file cannot be created in it.
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    vi.spyOn(console, "error").mockImplementation(() => {});

    chmodSync(dir, 0o500);
    process.env.IMPAMP_DB_PATH = join(dir, "impamp.db");

    expect(GET().status).toBe(503);
  });

  it("answers 503 when the path is not somewhere a database can live", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.IMPAMP_DB_PATH = "/dev/null/impamp/impamp.db";

    expect(GET().status).toBe(503);
  });

  it("does not cache, so a promoted container cannot coast on an old answer", () => {
    process.env.IMPAMP_DB_PATH = join(dir, "impamp.db");

    expect(GET().headers.get("Cache-Control")).toBe("no-store");
  });
});
