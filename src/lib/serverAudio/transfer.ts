/**
 * Moving audio between the local IndexedDB store and the hosted bucket.
 *
 * Both directions are content-addressed, which does most of the work: the same
 * sound assigned to five pads, or shared by five people, is one object. An
 * upload of audio already in the bucket sends no bytes at all.
 *
 * This is the optional half of server sync. When the deployment hosts no audio,
 * or the account is not approved, every function here is a no-op and audio
 * keeps flowing through Google Drive exactly as before.
 */

import {
  addOrReuseAudioFile,
  computeBlobHash,
  ensureAudioFileHash,
  getAudioFile,
  getAudioFileByHash,
  getDb,
  markAudioFilesHosted,
  type AudioFile,
} from "@/lib/db";
import {
  AudioHostingUnavailableError,
  AudioQuotaError,
  NotApprovedForAudioError,
  commitUpload,
  fetchAudioLibrary,
  requestProfileDownloadUrl,
  requestUploadUrl,
} from "./api";
import type { ProfileSyncData } from "@/lib/syncUtils";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { getAudioFileMetadata } from "@/lib/db";
import { proofOfPossession } from "./proofOfPossession";

/** Filename extension, lowercased and without the dot. */
export function extensionOf(name: string, contentType: string): string {
  const fromName = name.includes(".") ? name.split(".").pop()! : "";
  if (fromName) return fromName.toLowerCase();
  // Fall back to the subtype: "audio/mpeg" -> "mpeg".
  return contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "";
}

/**
 * Whether this deployment hosts audio *and* this account may use it.
 *
 * Cached for the session, because the answer is the same for every file in
 * every sync, and the common case — a deployment that hosts nothing — must not
 * cost a request per audio file per sync. `forgetAudioCapability` clears it
 * when the signed-in user changes.
 */
let capability: Promise<boolean> | null = null;

export function canHostAudio(): Promise<boolean> {
  capability ??= fetchAudioLibrary()
    .then((library) => library.canUploadAudio)
    .catch(() => {
      // Only a *successful* answer is worth keeping. Caching the failure meant
      // one bad minute — a timeout, a blip, a reconnecting laptop — disabled
      // hosted audio for the rest of the session with no way back short of a
      // reload. Clearing it here lets the next sync ask again.
      capability = null;
      return false;
    });
  return capability;
}

export function forgetAudioCapability(): void {
  capability = null;
}

export interface UploadOutcome {
  /** Hashes now hosted, whether uploaded here or already present. */
  hosted: string[];
  /** Human-readable reasons some files were not hosted. */
  warnings: string[];
  /** True when hosting stopped being possible — stop trying for this sync. */
  aborted: boolean;
}

/**
 * Upload every audio file the profile references that is not hosted yet, and
 * return the hashes that are now hosted.
 *
 * Refusals are reported rather than thrown: one file over quota should not
 * fail the whole sync, because the profile itself still syncs fine and the
 * audio simply stays in Drive.
 */
export async function uploadProfileAudio(
  audioFileIds: number[],
): Promise<UploadOutcome> {
  const hosted: string[] = [];
  const warnings: string[] = [];

  // The overwhelmingly common case: this deployment hosts no audio, or this
  // account is not approved. Costs one cached request, not one per file.
  if (!(await canHostAudio())) return { hosted, warnings, aborted: true };

  // One cursor pass for the metadata, so the decision about which files need
  // anything is made without reading a single blob. This loop used to open
  // every audio record and then issue `requestUploadUrl` *and* `commitUpload`
  // for all of them regardless — two sequential HTTP round trips per file, on
  // every sync, even for files the server already had. For a 500-sound profile
  // that is a thousand round trips and a thousand write transactions, and sync
  // runs on load, every 15 minutes, on reconnect, on every SSE event and ten
  // seconds after every edit.
  const metadata = await getAudioFileMetadata(audioFileIds);

  const needsUpload: number[] = [];
  for (const [id, meta] of metadata) {
    if (meta.serverHosted && meta.hash) {
      // Already up there. Still reported as hosted, because the caller uses
      // this list to tell readers where the bytes are.
      hosted.push(meta.hash);
    } else {
      needsUpload.push(id);
    }
  }

  // Marked in one transaction rather than one per hash — but flushed before
  // *every* exit, including the aborted ones, or a sync that gave up halfway
  // would forget the files it did manage to upload and re-upload them next
  // time.
  const newlyHosted: string[] = [];
  const rememberHosted = async () => {
    // splice hands over a fresh array and empties the buffer in one step. The
    // buffer must not be cleared *after* passing it on: the callee is async and
    // would be reading an array this had already emptied.
    const batch = newlyHosted.splice(0);
    if (batch.length > 0) await markAudioFilesHosted(batch);
  };

  for (const id of needsUpload) {
    const file = await getAudioFile(id);
    if (!file) continue;

    try {
      const hash = file.hash ?? (await computeBlobHash(file.blob));
      const extension = extensionOf(file.name, file.type);

      const ticket = await requestUploadUrl({
        hash,
        sizeBytes: file.blob.size,
        contentType: file.type,
        extension,
      });

      if (ticket.uploadUrl) {
        const response = await fetchWithTimeout(ticket.uploadUrl, {
          timeoutKind: "transfer",
          method: "PUT",
          body: file.blob,
          headers: { "content-type": file.type },
        });
        if (!response.ok) {
          warnings.push(`${file.name}: upload failed (${response.status})`);
          continue;
        }
      }

      await commitUpload({
        hash,
        name: file.name,
        contentType: file.type,
        extension,
        // Nothing was uploaded because someone else already stored these exact
        // bytes, so the server asks this device to show it has them rather
        // than taking the hash as evidence. We do have them — that is where
        // the hash came from.
        proof: ticket.proofRange
          ? await proofOfPossession(file.blob, ticket.proofRange)
          : undefined,
      });
      hosted.push(hash);
      // Remembered locally so a later sync that cannot upload — unapproved,
      // capped, or just unlucky — still tells readers where these bytes are.
      // Collected here and written once below: this used to open a separate
      // read-write transaction per hash.
      newlyHosted.push(hash);
    } catch (error) {
      // These two mean every later file would fail the same way.
      if (
        error instanceof NotApprovedForAudioError ||
        error instanceof AudioHostingUnavailableError
      ) {
        await rememberHosted();
        return { hosted, warnings, aborted: true };
      }
      if (error instanceof AudioQuotaError) {
        warnings.push(`${file.name}: ${error.message}`);
        // The global cap will refuse everything else too; a personal quota
        // might still have room for a smaller file.
        if (error.reason === "global_cap") {
          await rememberHosted();
          return { hosted, warnings, aborted: true };
        }
        continue;
      }
      warnings.push(
        `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await rememberHosted();
  return { hosted, warnings, aborted: false };
}

/**
 * Whether a download failure will still be a failure next time.
 *
 * Everything else is worth retrying, because the caller postpones the whole
 * pull while anything is retryable, and applying a pull whose audio never
 * arrived is what strips the pads and publishes them empty. The bias is
 * deliberate: a wrong "retryable" costs one more attempt, a wrong "permanent"
 * costs the sounds.
 */
function isPermanentAudioFailure(error: unknown): boolean {
  if (
    error instanceof NotApprovedForAudioError ||
    error instanceof AudioHostingUnavailableError
  ) {
    return true;
  }
  // The object is gone from the bucket for good. Retrying forever would stop
  // the profile syncing at all, which is worse than losing the one sound —
  // the same call the Drive downloader makes when a file has left the folder.
  return (error as { status?: number })?.status === 404;
}

/**
 * Fetch any server-hosted audio the profile references but this browser does
 * not have, and store it locally.
 *
 * Returns the warnings worth surfacing, plus the failures that are worth
 * retrying — the caller postpones applying a pull when anything is retryable,
 * because applying a profile whose audio is missing would strip those pads.
 */
export async function downloadProfileAudio(
  serverProfileId: string,
  audioRefs: ProfileSyncData["audioFiles"],
  shareToken?: string | null,
): Promise<{ warnings: string[]; retryable: string[]; downloaded: number }> {
  const warnings: string[] = [];
  const retryable: string[] = [];
  let downloaded = 0;

  const hostedRefs = (audioRefs ?? []).filter(
    (ref): ref is typeof ref & { hash: string } =>
      Boolean(ref.serverHosted && ref.hash),
  );
  if (hostedRefs.length === 0) return { warnings, retryable, downloaded };

  // Local files that predate hashing may still be the same audio. Built once,
  // and only if a reference actually misses the hash index.
  let hashlessIndex: Map<string, number> | null = null;
  const getHashlessIndex = async (): Promise<Map<string, number>> => {
    if (hashlessIndex) return hashlessIndex;
    hashlessIndex = new Map();
    const db = await getDb();
    for (const localId of await db.getAllKeys("audioFiles")) {
      const computed = await ensureAudioFileHash(localId);
      if (computed) hashlessIndex.set(computed, localId);
    }
    return hashlessIndex;
  };

  for (const ref of hostedRefs) {
    if (await getAudioFileByHash(ref.hash)) continue;
    if ((await getHashlessIndex()).has(ref.hash)) continue;

    try {
      const ticket = await requestProfileDownloadUrl(
        serverProfileId,
        ref.hash,
        shareToken,
      );

      const response = await fetchWithTimeout(ticket.url, {
        timeoutKind: "transfer",
      });
      if (!response.ok) {
        // A presigned URL that has expired, or a bucket hiccup — both are
        // worth another attempt on the next sync.
        retryable.push(`${ref.name}: download failed (${response.status})`);
        continue;
      }

      const blob = await response.blob();
      const stored: Omit<AudioFile, "id" | "createdAt"> = {
        name: ref.name,
        type: ref.type || ticket.contentType,
        blob,
        hash: ref.hash,
        // It came from the object store, so that is where it lives.
        serverHosted: true,
      };
      // Reuse by content hash. The check at the top of this loop is a
      // separate transaction from this write, and a browser runs several
      // syncs at once — one per connected profile, plus a second tab — so two
      // of them can both miss it and both fetch the same shared sound. Only a
      // lookup inside the writing transaction collapses that pair.
      const { reused } = await addOrReuseAudioFile(stored);
      if (reused) {
        // Reuse returns the row exactly as it found it, so it still does not
        // say the bucket holds these bytes — and that field is what decides
        // whether the next push uploads them all over again.
        await markAudioFilesHosted([ref.hash]);
      }
      downloaded++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Retryable unless the failure is permanent for this device. Only
      // `TypeError` used to count, so an expired session or a 5xx read as a
      // refusal: the sync carried on, `updateLocalData` could not resolve the
      // audio, and the pads were cleared and published empty. The Drive
      // downloader has always treated every throw as worth another go.
      if (isPermanentAudioFailure(error)) {
        warnings.push(`${ref.name}: ${message}`);
      } else {
        retryable.push(`${ref.name}: ${message}`);
      }
    }
  }

  return { warnings, retryable, downloaded };
}

/**
 * Mark the profile blob's audio references as hosted, so collaborators know to
 * fetch them from the server rather than from Drive.
 */
export function markHostedAudio(
  data: ProfileSyncData,
  hostedHashes: Set<string>,
): ProfileSyncData {
  if (hostedHashes.size === 0) return data;

  return {
    ...data,
    audioFiles: data.audioFiles.map((file) =>
      file.hash && hostedHashes.has(file.hash)
        ? { ...file, serverHosted: true }
        : file,
    ),
  };
}
