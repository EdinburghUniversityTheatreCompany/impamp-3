import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAudioHostingConfig, isAudioHostingConfigured } from "./config";

const REQUIRED = {
  IMPAMP_S3_ENDPOINT: "https://s3.eu-central-2.wasabisys.com/",
  IMPAMP_S3_REGION: "eu-central-2",
  IMPAMP_S3_BUCKET: "impamp-audio",
  IMPAMP_S3_ACCESS_KEY_ID: "key",
  IMPAMP_S3_SECRET_ACCESS_KEY: "secret",
};

// Every variable `getAudioHostingConfig` reads, because `beforeEach` clears
// exactly this list. The two URL TTLs were missing, so a developer with either
// exported saw different defaults from CI and the tests below said nothing
// about them either way.
const TOUCHED = [
  ...Object.keys(REQUIRED),
  "IMPAMP_AUDIO_GLOBAL_CAP_BYTES",
  "IMPAMP_AUDIO_USER_QUOTA_BYTES",
  "IMPAMP_AUDIO_MAX_OBJECT_BYTES",
  "IMPAMP_AUDIO_UPLOAD_URL_TTL",
  "IMPAMP_AUDIO_DOWNLOAD_URL_TTL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
  for (const key of TOUCHED) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("getAudioHostingConfig", () => {
  it("is off when nothing is configured", () => {
    expect(getAudioHostingConfig()).toBeNull();
    expect(isAudioHostingConfigured()).toBe(false);
  });

  it("stays off when the configuration is only half present", () => {
    // A deployment missing just the secret must not look enabled — better to
    // host nothing than to mint URLs that 403.
    Object.assign(process.env, REQUIRED);
    delete process.env.IMPAMP_S3_SECRET_ACCESS_KEY;
    expect(getAudioHostingConfig()).toBeNull();
  });

  it("reads a complete configuration and trims the endpoint's trailing slash", () => {
    Object.assign(process.env, REQUIRED);
    const config = getAudioHostingConfig();

    expect(config).not.toBeNull();
    expect(config!.endpoint).toBe("https://s3.eu-central-2.wasabisys.com");
    expect(config!.bucket).toBe("impamp-audio");
  });

  it("falls back to defaults for the optional limits", () => {
    Object.assign(process.env, REQUIRED);
    const config = getAudioHostingConfig()!;

    expect(config.globalCapBytes).toBe(100 * 1024 ** 3);
    expect(config.defaultUserQuotaBytes).toBe(2 * 1024 ** 3);
    expect(config.maxObjectBytes).toBe(100 * 1024 * 1024);
  });

  it("keeps the download URL short-lived, because the TTL is the revocation lag", () => {
    // Five minutes, not an hour, and not a day. A presigned URL is a bearer
    // credential that can be forwarded, and revoking a share cannot recall one
    // already issued — so this number is how long access outlives access.
    // Nothing asserted it, and `config.ts` argues for it at length: the default
    // could have been raised to 24 hours with the whole suite green.
    Object.assign(process.env, REQUIRED);
    const config = getAudioHostingConfig()!;

    expect(config.downloadUrlTtlSeconds).toBe(5 * 60);
    // Longer, deliberately: an upload has to survive the transfer itself.
    expect(config.uploadUrlTtlSeconds).toBe(15 * 60);
  });

  it("honours overridden TTLs", () => {
    Object.assign(process.env, REQUIRED, {
      IMPAMP_AUDIO_UPLOAD_URL_TTL: "60",
      IMPAMP_AUDIO_DOWNLOAD_URL_TTL: "30",
    });
    const config = getAudioHostingConfig()!;

    expect(config.uploadUrlTtlSeconds).toBe(60);
    expect(config.downloadUrlTtlSeconds).toBe(30);
  });

  it("honours overridden limits", () => {
    Object.assign(process.env, REQUIRED, {
      IMPAMP_AUDIO_GLOBAL_CAP_BYTES: "5000",
      IMPAMP_AUDIO_USER_QUOTA_BYTES: "1000",
    });
    const config = getAudioHostingConfig()!;

    expect(config.globalCapBytes).toBe(5000);
    expect(config.defaultUserQuotaBytes).toBe(1000);
  });

  it("trims whitespace off every value", () => {
    // A credential pasted with a stray leading space looks correct in every
    // vault UI but signs every request wrongly, and S3 says only
    // "SignatureDoesNotMatch". Cost a real debugging session on 2026-08-14.
    Object.assign(process.env, {
      IMPAMP_S3_ENDPOINT: "  https://s3.eu-west-1.wasabisys.com  ",
      IMPAMP_S3_REGION: " eu-west-1\n",
      IMPAMP_S3_BUCKET: "\timpamp-audio ",
      IMPAMP_S3_ACCESS_KEY_ID: " AKIAIOSFODNN7EXAMPLE",
      IMPAMP_S3_SECRET_ACCESS_KEY: " secret-with-leading-space",
    });
    const config = getAudioHostingConfig()!;

    expect(config.endpoint).toBe("https://s3.eu-west-1.wasabisys.com");
    expect(config.region).toBe("eu-west-1");
    expect(config.bucket).toBe("impamp-audio");
    expect(config.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(config.secretAccessKey).toBe("secret-with-leading-space");
  });

  it("treats an all-whitespace credential as not configured", () => {
    Object.assign(process.env, REQUIRED, {
      IMPAMP_S3_SECRET_ACCESS_KEY: "   ",
    });
    expect(getAudioHostingConfig()).toBeNull();
  });

  it("refuses a nonsense limit rather than silently defaulting", () => {
    Object.assign(process.env, REQUIRED, {
      IMPAMP_AUDIO_GLOBAL_CAP_BYTES: "not-a-number",
    });
    expect(() => getAudioHostingConfig()).toThrow(
      /IMPAMP_AUDIO_GLOBAL_CAP_BYTES/,
    );
  });

  it("refuses a negative limit", () => {
    Object.assign(process.env, REQUIRED, {
      IMPAMP_AUDIO_MAX_OBJECT_BYTES: "-1",
    });
    expect(() => getAudioHostingConfig()).toThrow();
  });
});
