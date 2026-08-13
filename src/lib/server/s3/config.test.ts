import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAudioHostingConfig, isAudioHostingConfigured } from "./config";

const REQUIRED = {
  IMPAMP_S3_ENDPOINT: "https://s3.eu-central-2.wasabisys.com/",
  IMPAMP_S3_REGION: "eu-central-2",
  IMPAMP_S3_BUCKET: "impamp-audio",
  IMPAMP_S3_ACCESS_KEY_ID: "key",
  IMPAMP_S3_SECRET_ACCESS_KEY: "secret",
};

const TOUCHED = [
  ...Object.keys(REQUIRED),
  "IMPAMP_AUDIO_GLOBAL_CAP_BYTES",
  "IMPAMP_AUDIO_USER_QUOTA_BYTES",
  "IMPAMP_AUDIO_MAX_OBJECT_BYTES",
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
