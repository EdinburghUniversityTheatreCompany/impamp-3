"use client";

import { useState, useEffect, useCallback } from "react";
import { useServerSync } from "@/hooks/useServerSync";
import type { ServerShare } from "@/lib/serverSync/types";

interface ServerSharingPanelProps {
  /** The profile's ID on the server, not its local IndexedDB id. */
  serverProfileId: string;
}

const ROLE_LABEL: Record<string, string> = {
  editor: "Can edit",
  viewer: "Can view",
};

/** The URL a collaborator opens to add a shared profile to their own app. */
function shareUrlFor(serverProfileId: string, token: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/server/open?id=${serverProfileId}&token=${token}`;
}

/**
 * Sharing controls for a server-synced profile.
 *
 * Unlike the Drive panel, invited collaborators get access the moment they
 * sign in — there is no Picker grant to chase, because the server owns the
 * permission rather than Google Drive.
 */
const loadFailureMessage = (err: unknown) =>
  err instanceof Error ? err.message : "Failed to load sharing";

export default function ServerSharingPanel({
  serverProfileId,
}: ServerSharingPanelProps) {
  const { listShares, addShare, revokeShare } = useServerSync();

  const [shares, setShares] = useState<ServerShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "editor">("editor");
  const [isInviting, setIsInviting] = useState(false);

  const [linkRole, setLinkRole] = useState<"viewer" | "editor">("viewer");
  const [isCreatingLink, setIsCreatingLink] = useState(false);
  const [copiedShareId, setCopiedShareId] = useState<number | null>(null);

  const fetchShares = useCallback(
    () => listShares(serverProfileId),
    [serverProfileId, listShares],
  );

  // The initial load, in the shape React documents for fetching in an effect:
  // state is set from the promise's callbacks, and a cancelled flag stops a
  // slow response from landing after unmount or after the panel has moved to
  // another profile. It used to call a shared loader that set state before its
  // first await, and had no cancellation at all.
  useEffect(() => {
    let cancelled = false;
    fetchShares().then(
      (next) => {
        if (cancelled) return;
        setShares(next);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(loadFailureMessage(err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchShares]);

  // Reload after a change. No spinner: every caller already shows its own
  // in-flight state (isInviting, isCreatingLink, …), and leaving the current
  // list on screen while it refreshes beats blanking it out.
  const loadShares = useCallback(async () => {
    try {
      setShares(await fetchShares());
      setError(null);
    } catch (err) {
      setError(loadFailureMessage(err));
    }
  }, [fetchShares]);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setIsInviting(true);
    setError(null);
    try {
      await addShare(serverProfileId, inviteRole, inviteEmail.trim());
      setInviteEmail("");
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite");
    } finally {
      setIsInviting(false);
    }
  };

  const handleCreateLink = async () => {
    setIsCreatingLink(true);
    setError(null);
    try {
      await addShare(serverProfileId, linkRole);
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create link");
    } finally {
      setIsCreatingLink(false);
    }
  };

  const handleRevoke = async (shareId: number) => {
    setError(null);
    try {
      await revokeShare(serverProfileId, shareId);
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke");
    }
  };

  const handleCopyLink = async (share: ServerShare) => {
    if (!share.linkToken) return;
    await navigator.clipboard.writeText(
      shareUrlFor(serverProfileId, share.linkToken),
    );
    setCopiedShareId(share.id);
    setTimeout(() => setCopiedShareId(null), 3000);
  };

  const emailShares = shares.filter((s) => s.email !== null);
  const linkShares = shares.filter((s) => s.linkToken !== null);

  return (
    <div className="mt-2 space-y-3" data-testid="server-sharing-panel">
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {/* People with access */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
          People with access:
        </p>
        {loading ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : emailShares.length === 0 ? (
          <p className="text-xs text-gray-400">Only you.</p>
        ) : (
          <ul className="space-y-1">
            {emailShares.map((share) => (
              <li
                key={share.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-xs text-gray-700 dark:text-gray-300 truncate">
                  {share.email}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                  {ROLE_LABEL[share.role]}
                </span>
                <button
                  onClick={() => handleRevoke(share.id)}
                  className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 shrink-0"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Invite people */}
      <div className="flex items-center gap-1 flex-wrap">
        <input
          type="email"
          placeholder="Email address"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleInvite()}
          aria-label="Email address to invite"
          data-testid="server-invite-email"
          className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-300 flex-1 min-w-0"
        />
        <select
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value as "viewer" | "editor")}
          aria-label="Invite role"
          className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-300"
        >
          <option value="editor">Can edit</option>
          <option value="viewer">Can view</option>
        </select>
        <button
          onClick={handleInvite}
          disabled={isInviting || !inviteEmail.trim()}
          data-testid="server-invite-button"
          className="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded hover:bg-blue-200 transition-colors dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40 disabled:opacity-50"
        >
          {isInviting ? "Inviting…" : "Invite"}
        </button>
      </div>

      {/* Share links */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Share links:
        </p>
        {linkShares.length === 0 ? (
          <p className="text-xs text-gray-400">None yet.</p>
        ) : (
          <ul className="space-y-1">
            {linkShares.map((share) => (
              <li
                key={share.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                  {ROLE_LABEL[share.role]}
                </span>
                <button
                  onClick={() => handleCopyLink(share)}
                  className="px-2 py-0.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 shrink-0"
                >
                  {copiedShareId === share.id ? "Copied!" : "Copy link"}
                </button>
                <button
                  onClick={() => handleRevoke(share.id)}
                  className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 shrink-0"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-1">
          <select
            value={linkRole}
            onChange={(e) => setLinkRole(e.target.value as "viewer" | "editor")}
            aria-label="Share link role"
            className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-300"
          >
            <option value="viewer">Can view</option>
            <option value="editor">Can edit</option>
          </select>
          <button
            onClick={handleCreateLink}
            disabled={isCreatingLink}
            data-testid="server-create-link"
            className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
          >
            {isCreatingLink ? "Creating…" : "Create link"}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        This governs the profile. Whether collaborators can <em>hear</em> it
        depends on where its sounds are stored.
      </p>
    </div>
  );
}
