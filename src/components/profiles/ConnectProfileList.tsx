"use client";

/**
 * Every profile you could bring onto this device, wherever it lives.
 *
 * There used to be a "Connect from your Drive" list and, for the server,
 * nothing at all — `listServerProfiles` existed and was called from nowhere.
 * So signing in on a new device showed you no sign of your own server
 * profiles, and the only route back to one was a share link, which assumes
 * somebody else is involved.
 *
 * One list rather than two, because "which of my profiles do I want here?" is
 * one question. Where each lives is an attribute of the answer, not a reason
 * to ask twice.
 */

import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { useProfileStore } from "@/store/profileStore";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { useServerSync } from "@/hooks/useServerSync";
import { useConnectServerProfile } from "@/hooks/useConnectServerProfile";
import { listServerProfiles } from "@/lib/serverSync/api";
import { syncTargetLabel } from "@/lib/syncState";
import type { SyncType } from "@/lib/db";
import { useConnectDriveProfile } from "@/hooks/useConnectDriveProfile";

interface ConnectableProfile {
  key: string;
  source: Extract<SyncType, "googleDrive" | "server">;
  /** Drive file id, or server profile id. */
  id: string;
  name: string;
  modifiedAt: number | null;
  /** Server profiles know this up front; Drive files do not. */
  access?: "owner" | "editor" | "viewer";
}

/** Strip the naming convention so a Drive row reads like the profile it is. */
function driveDisplayName(fileName: string): string {
  return fileName.replace(/^impamp-profile-/, "").replace(/\.json$/, "");
}

export default function ConnectProfileList({
  onConnected,
}: {
  onConnected?: (name: string) => void;
}) {
  const profiles = useProfileStore((s) => s.profiles);
  const isGoogleSignedIn = useProfileStore((s) => s.isGoogleSignedIn);

  const { listAppFiles } = useGoogleDriveSync();
  const { connectByFileId } = useConnectDriveProfile();
  const { isServerSignedIn } = useServerSync();
  const connectServerProfile = useConnectServerProfile();

  const [items, setItems] = useState<ConnectableProfile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [followKeys, setFollowKeys] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<string | null>(null);

  /**
   * Fetch both sources. Deliberately returns its findings rather than setting
   * state, so the effect below can await it and write state only afterwards —
   * a loader that sets state on its first synchronous line cascades renders.
   *
   * Each source is gathered independently: being signed out of one, or one
   * being unreachable, must not hide the other.
   */
  const gather = useCallback(async (): Promise<{
    items: ConnectableProfile[];
    error: string | null;
  }> => {
    const found: ConnectableProfile[] = [];
    const problems: string[] = [];

    if (isServerSignedIn) {
      try {
        for (const p of await listServerProfiles()) {
          found.push({
            key: `server:${p.id}`,
            source: "server",
            id: p.id,
            name: p.name,
            modifiedAt: p.updatedAt,
            access: p.access,
          });
        }
      } catch {
        problems.push("Could not list profiles on the ImpAmp server.");
      }
    }

    if (isGoogleSignedIn) {
      try {
        for (const f of await listAppFiles()) {
          found.push({
            key: `drive:${f.id}`,
            source: "googleDrive",
            id: f.id,
            name: driveDisplayName(f.name),
            modifiedAt: f.modifiedTime ? Date.parse(f.modifiedTime) : null,
          });
        }
      } catch {
        problems.push("Could not list files in Google Drive.");
      }
    }

    found.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    return { items: found, error: problems.join(" ") || null };
  }, [isServerSignedIn, isGoogleSignedIn, listAppFiles]);

  useEffect(() => {
    if (!isServerSignedIn && !isGoogleSignedIn) return;
    let cancelled = false;
    void gather().then((result) => {
      if (cancelled) return;
      setItems(result.items);
      setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [isServerSignedIn, isGoogleSignedIn, gather]);

  /** Refresh is an event, so it may show a spinner without cascading. */
  const refresh = async () => {
    setLoading(true);
    try {
      const result = await gather();
      setItems(result.items);
      setError(result.error);
    } finally {
      setLoading(false);
    }
  };

  /** Already here? Then connecting again would just make a second copy. */
  const localFor = (item: ConnectableProfile) =>
    profiles.find((p) =>
      item.source === "server"
        ? p.serverProfileId === item.id
        : p.googleDriveFileId === item.id,
    );

  const connect = async (item: ConnectableProfile) => {
    setBusyKey(item.key);
    setError(null);
    try {
      if (item.source === "server") {
        const outcome = await connectServerProfile(item.id, {
          followOnly: followKeys.has(item.key),
          onProgress: (p) =>
            setProgress(
              `Downloading sounds (${p.processedFiles} of ${p.totalFiles})…`,
            ),
        });
        onConnected?.(outcome.name);
      } else {
        const outcome = await connectByFileId(item.id, {
          followOnly: followKeys.has(item.key),
          onProgress: (p) =>
            setProgress(
              `Downloading sounds (${p.processedFiles} of ${p.totalFiles})…`,
            ),
        });
        onConnected?.(outcome.name);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not connect that profile.",
      );
    } finally {
      setBusyKey(null);
      setProgress(null);
    }
  };

  if (!isGoogleSignedIn && !isServerSignedIn) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Sign in with Google to see profiles you can bring onto this device, from
        Google Drive or the ImpAmp server.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="connect-profile-list">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Connect a profile
        </h4>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          data-testid="connect-list-refresh"
          className="rounded-md bg-blue-100 px-3 py-1 text-xs text-blue-700 transition-colors hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      {progress && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{progress}</p>
      )}

      {items !== null && items.length === 0 && !loading && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Nothing to connect — no profiles on the server, and no ImpAmp files in
          your Drive.
        </p>
      )}

      <ul className="divide-y divide-gray-200 rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
        {(items ?? []).map((item) => {
          const local = localFor(item);
          const busy = busyKey === item.key;

          return (
            <li
              key={item.key}
              data-testid="connect-profile-row"
              data-source={item.source}
              className="flex flex-wrap items-center gap-2 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-gray-900 dark:text-gray-100">
                  {item.name}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  <span
                    data-testid="connect-profile-source"
                    className={`mr-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      item.source === "server"
                        ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300"
                        : "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300"
                    }`}
                  >
                    {syncTargetLabel(item.source)}
                  </span>
                  {item.access && item.access !== "owner" && (
                    <span className="mr-1">
                      shared with you ·{" "}
                      {item.access === "viewer" ? "view only" : "can edit"} ·
                    </span>
                  )}
                  {item.modifiedAt
                    ? `updated ${formatDistanceToNow(new Date(item.modifiedAt), { addSuffix: true })}`
                    : "never updated"}
                </p>
              </div>

              {/*
                Following is a choice about contributing, so it is offered
                wherever you *could* contribute. A server row you can only view
                is already view-only and has nothing to choose.
              */}
              {!local && item.access !== "viewer" && (
                <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
                  <input
                    type="checkbox"
                    // Every row's label reads "Follow only", so on its own it
                    // tells a screen reader nothing about which profile.
                    aria-label={`Follow "${item.name}" without contributing`}
                    checked={followKeys.has(item.key)}
                    onChange={(e) =>
                      setFollowKeys((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(item.key);
                        else next.delete(item.key);
                        return next;
                      })
                    }
                  />
                  Follow only
                </label>
              )}

              {local ? (
                <span
                  data-testid="connect-profile-already"
                  className="rounded-md bg-gray-100 px-3 py-1 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                >
                  Already here
                </span>
              ) : (
                <button
                  onClick={() => void connect(item)}
                  disabled={busy || busyKey !== null}
                  data-testid="connect-profile-button"
                  className="rounded-md bg-blue-500 px-3 py-1 text-xs text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
                >
                  {busy ? "Connecting…" : "Connect"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
