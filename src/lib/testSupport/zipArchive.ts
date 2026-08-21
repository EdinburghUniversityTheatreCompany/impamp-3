/**
 * Hand-built `.iaz`-shaped archives, for the tests that have to hand a parser
 * something its own writer would never produce.
 *
 * Both archive readers take a file from a picker, so the cases that matter
 * are the malformed ones: a manifest that is not JSON, an entry the manifest
 * promises and the archive does not hold, a folder name that says `../../..`.
 * None of those can be produced by exporting; they have to be assembled.
 *
 * zip.js is imported dynamically rather than at module scope, so importing
 * this helper cannot pull the library into a suite that only names it in one
 * test.
 */

/** Builds a `.iaz`-shaped archive with exactly the entries given. */
export async function makeArchive(
  entries: Record<string, string>,
): Promise<Blob> {
  const zipjs = await import("@zip.js/zip.js");
  zipjs.configure({ useWebWorkers: false });
  const writer = new zipjs.ZipWriter(new zipjs.BlobWriter("application/zip"));
  for (const [name, text] of Object.entries(entries)) {
    await writer.add(name, new zipjs.TextReader(text));
  }
  return writer.close();
}
