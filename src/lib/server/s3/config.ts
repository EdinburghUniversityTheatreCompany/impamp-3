/**
 * Configuration for optional, gated audio hosting on S3-compatible storage
 * (Wasabi in the org's deployment).
 *
 * Every value is read from the environment, and the feature is *off* unless
 * all of them are present. A deployment that sets none of these behaves
 * exactly as before: audio lives in Google Drive and the server hosts nothing.
 *
 * Server-only — this reads the secret access key.
 */

/** Bytes in a gibibyte, for the human-readable defaults below. */
const GIB = 1024 * 1024 * 1024;

export interface AudioHostingConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Ceiling across every hosted object, whoever uploaded it. */
  globalCapBytes: number;
  /** Applied to an approved user who has no explicit override. */
  defaultUserQuotaBytes: number;
  /** Lifetime of a presigned upload URL. */
  uploadUrlTtlSeconds: number;
  /** Lifetime of a presigned download URL. */
  downloadUrlTtlSeconds: number;
  /** Rejected before a URL is ever minted. */
  maxObjectBytes: number;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive number, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * The config, or `null` when audio hosting is not configured. Callers treat
 * `null` as "this deployment does not host audio" rather than as an error.
 */
export function getAudioHostingConfig(): AudioHostingConfig | null {
  const endpoint = process.env.IMPAMP_S3_ENDPOINT;
  const region = process.env.IMPAMP_S3_REGION;
  const bucket = process.env.IMPAMP_S3_BUCKET;
  const accessKeyId = process.env.IMPAMP_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.IMPAMP_S3_SECRET_ACCESS_KEY;

  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    globalCapBytes: readNumber("IMPAMP_AUDIO_GLOBAL_CAP_BYTES", 100 * GIB),
    defaultUserQuotaBytes: readNumber("IMPAMP_AUDIO_USER_QUOTA_BYTES", 2 * GIB),
    uploadUrlTtlSeconds: readNumber("IMPAMP_AUDIO_UPLOAD_URL_TTL", 15 * 60),
    downloadUrlTtlSeconds: readNumber("IMPAMP_AUDIO_DOWNLOAD_URL_TTL", 60 * 60),
    maxObjectBytes: readNumber(
      "IMPAMP_AUDIO_MAX_OBJECT_BYTES",
      100 * 1024 * 1024,
    ),
  };
}

export function isAudioHostingConfigured(): boolean {
  return getAudioHostingConfig() !== null;
}
