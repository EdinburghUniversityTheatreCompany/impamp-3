/** The shape of `src/generated/build-info.json`. */
export interface BuildInfo {
  version: string;
  commitHash: string;
  buildDate: string;
}

/**
 * The version line the Help modal shows: which build is this?
 *
 * The commit answers that when it is known. An image built without `.git` and
 * without a `GIT_SHA` build arg, which is every image the Portainer stack
 * builds, reports "nogit" instead, and "0.42.0-nogit" is the same string for
 * every one of them. The build date is in the same file and does tell them
 * apart, so it stands in for the commit. A date that does not parse keeps the
 * old label rather than printing "Invalid Date".
 */
export function versionLabel(info: BuildInfo): string {
  if (info.commitHash !== "nogit") return `${info.version}-${info.commitHash}`;

  const built = new Date(info.buildDate);
  if (Number.isNaN(built.getTime())) {
    return `${info.version}-${info.commitHash}`;
  }
  const stamp = built.toISOString().slice(0, 16).replace("T", " ");
  return `${info.version}, built ${stamp} UTC`;
}
