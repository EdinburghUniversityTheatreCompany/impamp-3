import { NextRequest, NextResponse } from "next/server";
import { subscribeToProfile } from "@/lib/server/events";
import { loadAuthorizedProfile } from "@/lib/server/profileRequests";

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
  const loaded = loadAuthorizedProfile(request, id);
  if (loaded instanceof NextResponse) return loaded;

  const encoder = new TextEncoder();

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
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

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

      const current = loadAuthorizedProfile(request, id);
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
        if (loadAuthorizedProfile(request, id) instanceof NextResponse) {
          cleanup();
          return;
        }
        send(`: keep-alive\n\n`);
      }, HEARTBEAT_MS);

      open.lifetime = setTimeout(cleanup, MAX_STREAM_MS);
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
