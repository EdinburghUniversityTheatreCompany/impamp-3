/**
 * Audio rows for suites that run against a real (fake-indexeddb) database.
 *
 * The ids matter and cannot be hardcoded: `getDb` memoises its connection, so
 * a suite empties the stores between tests rather than swapping the database,
 * and autoIncrement keys keep climbing. Every assertion has to key off an id
 * the store handed back, which is what this returns.
 */

import { computeBlobHash, getDb } from "@/lib/db";
import type { LoudnessAnalysis } from "@/lib/audio/loudness/types";

/**
 * A loudness analysis, in the smallest shape the type accepts.
 *
 * For suites that only care *whether* a row carries an analysis — which row
 * the dedup collapse elects as canonical, whether a reused row kept the one it
 * had. A fresh object each call, because callers store it and the two typed
 * arrays are mutable.
 */
export function someAnalysis(): LoudnessAnalysis {
  return {
    algoVersion: 1,
    sampleRate: 48000,
    duration: 1,
    blockMeanSquare: new Float32Array([0.5]),
    hopTruePeak: new Float32Array([0.5]),
  };
}

export async function addAudioFiles(
  files: { name: string; hash: string; type?: string }[],
): Promise<number[]> {
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  const ids: number[] = [];
  for (const file of files) {
    ids.push(
      await tx.objectStore("audioFiles").add({
        blob: new Blob([file.name]),
        name: file.name,
        type: file.type ?? "audio/mpeg",
        hash: file.hash,
        createdAt: new Date(0),
      }),
    );
  }
  await tx.done;
  return ids;
}

/**
 * A sound as a device that predates hashing holds it: real bytes, no stored
 * hash.
 *
 * Written straight to the store rather than through `addAudioFile`, which
 * computes a hash and would have to be undone. The hash comes back anyway,
 * because that is what a *remote* reference to these bytes carries and what
 * the local row is missing — which is the whole shape of the legacy case.
 *
 * @param name - The file name, which must never be what identifies it
 * @param bytes - The content, as a string
 * @param type - The MIME type
 * @returns The row's id and the SHA-256 of its bytes, which the store lacks
 */
export async function addLegacyAudioFile(
  name: string,
  bytes: string,
  type = "audio/mpeg",
): Promise<{ id: number; hash: string }> {
  const blob = new Blob([bytes], { type });
  const db = await getDb();
  const id = await db.add("audioFiles", {
    blob,
    name,
    type,
    createdAt: new Date(0),
  });
  return { id, hash: await computeBlobHash(blob) };
}
