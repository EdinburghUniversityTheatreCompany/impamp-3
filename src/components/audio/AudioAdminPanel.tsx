"use client";

import { useEffect, useState } from "react";
import { formatBytes, usedFraction } from "@/lib/serverAudio/format";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

interface UserRow {
  userId: number;
  email: string;
  name: string | null;
  canUploadAudio: boolean;
  usedBytes: number;
  quotaBytes: number;
  fileCount: number;
}

interface AdminAudio {
  global: { usedBytes: number; capBytes: number; objectCount: number };
  defaultUserQuotaBytes: number;
  maxObjectBytes: number;
  users: UserRow[];
}

/**
 * Who may store audio, how much each of them is using, and how close the
 * deployment as a whole is to its cap.
 *
 * Renders nothing for a non-admin: the API answers 404 rather than 403 for
 * them, so there is nothing to show and nothing to explain.
 */
export default function AudioAdminPanel() {
  const [data, setData] = useState<AdminAudio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);

  /** Bumped to ask the effect below for a fresh read. */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Not a bare `fetch`: this file already imports the wrapper and uses it
    // for the PATCH below, and a GET with no deadline leaves the panel on its
    // spinner for as long as the socket stays open.
    fetchWithTimeout("/api/admin/audio")
      .then(async (response) => {
        if (!response.ok) {
          // 404 is the ordinary answer for a non-admin, and 501 for a
          // deployment that hosts no audio — neither is a failure to report.
          if (!cancelled) {
            if (response.status !== 404 && response.status !== 501) {
              setError("Could not load audio administration");
            }
            setData(null);
          }
          return;
        }
        const body = await response.json();
        if (!cancelled) setData(body);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load audio administration");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const patch = async (userId: number, body: Record<string, unknown>) => {
    setSaving(userId);
    setError(null);
    try {
      const response = await fetchWithTimeout(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Update refused");
      setReloadToken((token) => token + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(null);
    }
  };

  const editQuota = (user: UserRow, defaultQuota: number) => {
    const answer = prompt(
      `Storage allowance for ${user.email}, in MB.\nLeave blank to use the server default (${formatBytes(defaultQuota)}).`,
      String(Math.round(user.quotaBytes / (1024 * 1024))),
    );
    if (answer === null) return;

    if (answer.trim() === "") {
      patch(user.userId, { audioQuotaBytes: null });
      return;
    }
    const megabytes = Number(answer);
    if (!Number.isFinite(megabytes) || megabytes < 0) {
      setError("That is not a number of megabytes");
      return;
    }
    patch(user.userId, {
      audioQuotaBytes: Math.round(megabytes * 1024 * 1024),
    });
  };

  if (!data) {
    return error ? (
      <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
        {error}
      </div>
    ) : null;
  }

  const globalFraction = usedFraction(
    data.global.usedBytes,
    data.global.capBytes,
  );

  return (
    <section className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">Server audio (all users)</h3>
          <span className="text-xs text-gray-600 dark:text-gray-400">
            {formatBytes(data.global.usedBytes)} of{" "}
            {formatBytes(data.global.capBytes)} · {data.global.objectCount}{" "}
            file(s)
          </span>
        </div>
        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={data.global.capBytes}
          aria-valuenow={data.global.usedBytes}
          aria-label="Total server audio storage used"
        >
          <div
            className={`h-full rounded-full ${
              globalFraction > 0.9 ? "bg-red-500" : "bg-blue-500"
            }`}
            style={{ width: `${globalFraction * 100}%` }}
          />
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Identical audio uploaded by several people is stored — and counted
          here — once, though it counts against each of their allowances.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-gray-600 dark:text-gray-400">
            <tr>
              <th scope="col" className="py-2 pr-2">
                User
              </th>
              <th scope="col" className="py-2 pr-2">
                Used
              </th>
              <th scope="col" className="py-2 pr-2">
                Allowance
              </th>
              <th scope="col" className="py-2">
                May upload
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {data.users.map((user) => (
              <tr key={user.userId}>
                <td className="py-2 pr-2">
                  <span className="block truncate" title={user.email}>
                    {user.email}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {user.fileCount} file(s)
                  </span>
                </td>
                <td className="py-2 pr-2 tabular-nums">
                  {formatBytes(user.usedBytes)}
                </td>
                <td className="py-2 pr-2">
                  <button
                    type="button"
                    onClick={() => editQuota(user, data.defaultUserQuotaBytes)}
                    disabled={saving === user.userId}
                    className="rounded px-1 tabular-nums underline decoration-dotted hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700"
                  >
                    {formatBytes(user.quotaBytes)}
                  </button>
                </td>
                <td className="py-2">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={user.canUploadAudio}
                      disabled={saving === user.userId}
                      onChange={(event) =>
                        patch(user.userId, {
                          canUploadAudio: event.target.checked,
                        })
                      }
                      className="h-4 w-4"
                    />
                    <span className="sr-only">
                      Allow {user.email} to upload audio
                    </span>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
