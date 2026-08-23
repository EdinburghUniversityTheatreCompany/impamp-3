import { NextRequest, NextResponse } from "next/server";
import { subscribeToProfile } from "@/lib/server/events";
import { loadAuthorizedProfileMeta } from "@/lib/server/profileRequests";
import { acquire, clientKey, LIMITS } from "@/lib/server/rateLimit";

/**
 * Server-sent events for one profile: "it changed, pull again".
 *
 * GET /api/profiles/:id/events
 *
 * This is what replaces Drive's 15-minute polling window with roughly a
 * second. The payload deliberately carries only the new version, never the
 * data — the client pulls through the normal ETag path, so there is one code
 * path for reading a profile and no way for an event to deliver stale bytes.
 */

// A streaming response must not be cached or statically analysed.
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

/**
 * How long one connection may live before the client is asked to reconnect.
 *
 * Access was checked once, at connect, and never again, and the stream had no
 * end — so someone whose share you revoked kept receiving version bumps until
 * they closed the tab. Re-checking on every heartbeat handles the common case;
 * this bounds the worst one, and `EventSource` reconnects on its own.
 */
const MAX_STREAM_MS = 30 * 60_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = loadAuthorizedProfileMeta(request, id);
  if (loaded instanceof NextResponse) return loaded;

  // A stream is cheap to open and not cheap to hold: the heartbeat below
  // re-authorises on a 25s timer, and `loadAuthorizedProfileMeta` is four
  // synchronous SQLite queries on the thread that serves every other request.
  // Nothing bounded how many one caller could hold, and the endpoint is
  // reachable anonymously — `resolveAccess` grants on a link token, which is a
  // URL that by design circulates.
  //
  // Keyed on the session where there is one and the client address otherwise,
  // so a signed-in operator's tabs are counted together rather than being
  // pooled with everyone behind the same venue NAT.
  const watcher = watcherKey(request, loaded.user?.id ?? null);
  const releaseSlot = watcher ? acquire(watcher, LIMITS.sseStreams) : () => {};
  if (!releaseSlot) {
    return NextResponse.json(
      { error: "Too many open connections for this client" },
      { status: 429, headers: { "Retry-After": "30" } },
    );
  }

  const encoder = new TextEncoder();

  // Hoisted out of `start` so the stream's own `cancel` can reach it. Without
  // that, a teardown the runtime performs *without* aborting the request —
  // cancelling the response body — released nothing, and the connection slot
  // taken above leaked. The abort path covers the ordinary client disconnect;
  // this covers the rest, and a deadline that depends on someone else firing a
  // signal is the kind found not to work in front of an audience.
  let teardown = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let done = false;
      // One holder rather than three bindings, because `cleanup` has to be
      // defined before any of them exist and still be able to release them.
      const open: {
        heartbeat?: ReturnType<typeof setInterval>;
        lifetime?: ReturnType<typeof setTimeout>;
        unsubscribe?: () => void;
      } = {};

      // Defined before anything that might need it. A failed write used to
      // set a flag and stop there, leaving the heartbeat interval and the
      // subscription running for the life of the process.
      const cleanup = () => {
        if (done) return;
        done = true;
        if (open.heartbeat) clearInterval(open.heartbeat);
        if (open.lifetime) clearTimeout(open.lifetime);
        open.unsubscribe?.();
        // Every way this stream can end comes through here — abort, write
        // failure, revoked access, the lifetime cap — so this is the one place
        // the slot has to be given back. `acquire`'s release is idempotent
        // anyway, because `done` is not the only thing that has ever guarded
        // this function.
        releaseSlot();
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      teardown = cleanup;

      const send = (chunk: string) => {
        if (done) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away between our check and the write.
          cleanup();
        }
      };

      // A request can arrive already aborted, in which case the listener would
      // never fire and everything below would run until the process ended.
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup);

      // Subscribed *before* the current version is read, so a write landing in
      // between is delivered rather than missed. The client re-pulls on any
      // event, so hearing about one twice costs nothing, while hearing about
      // it once too few leaves it stale with no polling fallback to save it.
      open.unsubscribe = subscribeToProfile(id, (change) => {
        send(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
      });

      const current = loadAuthorizedProfileMeta(request, id);
      send(
        `event: change\ndata: ${JSON.stringify({
          profileId: id,
          version:
            current instanceof NextResponse
              ? loaded.profile.version
              : current.profile.version,
        })}\n\n`,
      );

      open.heartbeat = setInterval(() => {
        // Still allowed? A grant can be withdrawn while the stream is open,
        // and nothing else here would ever notice: access was checked once,
        // at connect, so a revoked collaborator kept receiving version bumps
        // until they closed the tab.
        if (loadAuthorizedProfileMeta(request, id) instanceof NextResponse) {
          cleanup();
          return;
        }
        send(`: keep-alive\n\n`);
      }, HEARTBEAT_MS);

      open.lifetime = setTimeout(cleanup, MAX_STREAM_MS);
    },
    cancel() {
      teardown();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx-style proxies buffer streamed bodies unless told not to.
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * The bucket an SSE connection is counted against.
 *
 * The account first, where the caller has one: it identifies the person rather
 * than the network, so a venue full of people behind one NAT is not counted as
 * one caller. The id comes from the authorisation that has already happened,
 * so this costs no extra query — and deliberately not the session token, which
 * would park a live credential in a long-lived map as a key.
 *
 * Falls back to the client address for an anonymous link-share viewer, who has
 * no account. `null` — anonymous *and* nothing in front of the app — means the
 * cap is not applied, matching `clientKey`'s contract.
 */
function watcherKey(
  request: NextRequest,
  userId: number | null,
): string | null {
  if (userId !== null) return `sse:user:${userId}`;

  const address = clientKey(request);
  return address ? `sse:ip:${address}` : null;
}
