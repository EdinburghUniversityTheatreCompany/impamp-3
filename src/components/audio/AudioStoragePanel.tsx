"use client";

import { useEffect, useState } from "react";
import {
  AudioHostingUnavailableError,
  deleteHostedAudio,
  fetchAudioLibrary,
  type AudioUsage,
  type HostedAudioFile,
} from "@/lib/serverAudio/api";
import { formatBytes, usedFraction } from "@/lib/serverAudio/format";
import { forgetAudioCapability } from "@/lib/serverAudio/transfer";

/**
 * What this account is storing on the server, and how much of its allowance
 * that uses.
 *
 * Renders nothing at all when the deployment hosts no audio, which is the
 * default — there is no point showing an empty allowance for a feature that
 * is not switched on.
 */
export default function AudioStoragePanel() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "unavailable" }
    | { kind: "error"; message: string }
    | {
        kind: "ready";
        canUploadAudio: boolean;
        usage: AudioUsage;
        files: HostedAudioFile[];
      }
  >({ kind: "loading" });
  const [deleting, setDeleting] = useState<string | null>(null);
  /** Bumped to ask the effect below for a fresh read. */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchAudioLibrary().then(
      (library) => {
        if (!cancelled) setState({ kind: "ready", ...library });
      },
      (error: unknown) => {
        if (cancelled) return;
        // The ordinary answer on a deployment that hosts nothing.
        if (error instanceof AudioHostingUnavailableError) {
          setState({ kind: "unavailable" });
          return;
        }
        setState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Could not read storage",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const remove = async (hash: string, name: string) => {
    if (!confirm(`Remove "${name}" from server storage?`)) return;
    setDeleting(hash);
    try {
      await deleteHostedAudio(hash);
      // The allowance changed, so the cached "may I upload" answer is stale.
      forgetAudioCapability();
      setReloadToken((token) => token + 1);
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not delete",
      });
    } finally {
      setDeleting(null);
    }
  };

  if (state.kind === "loading" || state.kind === "unavailable") return null;

  if (state.kind === "error") {
    return (
      <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
        {state.message}
      </div>
    );
  }

  const { usage, files, canUploadAudio } = state;
  const fraction = usedFraction(usage.usedBytes, usage.quotaBytes);
  const nearlyFull = fraction > 0.9;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Server audio storage</h3>
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)}
        </span>
      </div>

      {!canUploadAudio ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          This account is not approved to store audio on the server. Your audio
          syncs through Google Drive instead. Ask an admin if you need it.
        </p>
      ) : (
        <>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={usage.quotaBytes}
            aria-valuenow={usage.usedBytes}
            aria-label="Server audio storage used"
          >
            <div
              className={`h-full rounded-full transition-all ${
                nearlyFull ? "bg-amber-500" : "bg-blue-500"
              }`}
              style={{ width: `${fraction * 100}%` }}
            />
          </div>

          {files.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Nothing stored yet. Audio you add to a server-synced profile is
              uploaded automatically.
            </p>
          ) : (
            <ul className="divide-y divide-gray-200 text-sm dark:divide-gray-700">
              {files.map((file) => (
                <li
                  key={file.hash}
                  className="flex items-center justify-between gap-2 py-2"
                >
                  <span className="min-w-0 flex-1 truncate" title={file.name}>
                    {file.name}
                  </span>
                  <span className="shrink-0 text-xs text-gray-600 dark:text-gray-400">
                    {formatBytes(file.sizeBytes)}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(file.hash, file.name)}
                    disabled={deleting === file.hash}
                    className="shrink-0 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/30"
                  >
                    {deleting === file.hash ? "Removing…" : "Remove"}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Removing a file frees your allowance straight away. It only leaves
            the server once nobody else is using the same audio.
          </p>
        </>
      )}
    </section>
  );
}
