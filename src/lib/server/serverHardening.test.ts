/**
 * Three server-side grants that were wider than intended.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { closeDb, getDb, execute } from "./db";
import { upsertUserFromGoogle } from "./users";
import { isSameHostRequest } from "@/app/api/drive/proxyUtils";

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
});

const identity = (sub: string, email: string) => ({
  sub,
  email,
  name: "Someone",
  picture: null,
});

describe("taking over an account by email address", () => {
  it("does not hand over the admin flag with it", () => {
    // The first user to sign in becomes the deployment's admin, so the address
    // most likely to be recycled is the one holding it. Taking over the
    // account by address is deliberate — inheriting ownership of the
    // deployment on top of that is a different order of thing.
    const first = upsertUserFromGoogle(identity("sub-original", "a@x.test"));
    expect(first.is_admin).toBe(1);

    const takenOver = upsertUserFromGoogle(identity("sub-new", "a@x.test"));

    expect(takenOver.id).toBe(first.id);
    expect(takenOver.google_sub).toBe("sub-new");
    expect(takenOver.is_admin).toBe(0);
  });

  it("still moves the row, so the account is not lost", () => {
    const first = upsertUserFromGoogle(identity("sub-original", "b@x.test"));
    const again = upsertUserFromGoogle(identity("sub-new", "b@x.test"));

    // One row, not two — inserting instead used to throw UNIQUE on the email
    // and leave that person without server sync.
    expect(again.id).toBe(first.id);
  });

  it("leaves a non-admin's other grants alone", () => {
    upsertUserFromGoogle(identity("sub-admin", "admin@x.test"));
    const user = upsertUserFromGoogle(identity("sub-a", "c@x.test"));
    execute("UPDATE users SET can_upload_audio = 1 WHERE id = ?", user.id);

    const takenOver = upsertUserFromGoogle(identity("sub-b", "c@x.test"));

    // Audio approval is a per-account allowance, not deployment ownership.
    expect(takenOver.can_upload_audio).toBe(1);
  });
});

/** A request to the Drive proxy carrying exactly the given headers. */
function proxyRequest(headers: Record<string, string>) {
  return new NextRequest("https://impamp.test/api/drive/public-file?id=x", {
    headers,
  });
}

describe("the Drive proxy's same-origin gate", () => {
  it("refuses a caller that sends no origin signal at all", () => {
    // The proxies are unauthenticated, unrate-limited, serve up to 100 MB and
    // spend the deployment's own Google API key. Omitting both headers used to
    // be read as "probably a same-origin fetch"; it is also one curl.
    expect(isSameHostRequest(proxyRequest({}))).toBe(false);
  });

  it("allows the app's own fetches", () => {
    expect(
      isSameHostRequest(proxyRequest({ "sec-fetch-site": "same-origin" })),
    ).toBe(true);
  });

  it("refuses a cross-site fetch even when it claims our Referer", () => {
    // Sec-Fetch-Site cannot be set by page script, so it wins over a header
    // that can.
    expect(
      isSameHostRequest(
        proxyRequest({
          "sec-fetch-site": "cross-site",
          referer: "https://impamp.test/",
        }),
      ),
    ).toBe(false);
  });

  it("refuses a URL typed into the address bar", () => {
    expect(isSameHostRequest(proxyRequest({ "sec-fetch-site": "none" }))).toBe(
      false,
    );
  });

  it("falls back to Referer for clients that send no Sec-Fetch-Site", () => {
    expect(
      isSameHostRequest(proxyRequest({ referer: "https://impamp.test/app" })),
    ).toBe(true);
    expect(
      isSameHostRequest(proxyRequest({ referer: "https://elsewhere.test/" })),
    ).toBe(false);
  });
});
