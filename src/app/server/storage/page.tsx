"use client";

import Link from "next/link";
import AudioAdminPanel from "@/components/audio/AudioAdminPanel";
import AudioStoragePanel from "@/components/audio/AudioStoragePanel";

/**
 * Server audio storage: what this account is using, and — for an admin — what
 * everyone is using and who is allowed to upload.
 *
 * Both panels render nothing when the deployment hosts no audio, so on a
 * default deployment this page is just its heading and the explanation of why
 * there is nothing here.
 */
export default function ServerStoragePage() {
  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Server audio storage</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Optional. Audio normally syncs through Google Drive; a server that has
          been set up to host audio can store it for approved accounts instead.
        </p>
      </header>

      <AudioStoragePanel />
      <AudioAdminPanel />

      <Link
        href="/"
        className="inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
      >
        ← Back to the pads
      </Link>
    </main>
  );
}
