/** Byte sizes for humans. Shared by the storage and admin panels. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;

  // One decimal below 10 of a unit ("1.4 GB"), none above it ("14 GB").
  const digits = exponent === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

/** Fraction of an allowance used, clamped to 0–1 for a progress bar. */
export function usedFraction(usedBytes: number, limitBytes: number): number {
  if (limitBytes <= 0) return 0;
  return Math.min(1, Math.max(0, usedBytes / limitBytes));
}
