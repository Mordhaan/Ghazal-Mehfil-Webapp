import { NextRequest } from "next/server";

/**
 * REAL presence counter.
 *
 * Each browser tab opens one SSE stream and periodically pings `/api/presence`.
 * The server keeps a Map of live streams and broadcasts the true number of open
 * ones. A stream is dropped when:
 *   1. the client's abort/cancel handler fires (tab close, navigation), or
 *   2. a heartbeat write throws (socket already gone), or
 *   3. the client stops pinging for LIVE_TTL_MS (crash, sleep, network drop).
 *
 * There is no random number and no stored baseline: with nothing connected the
 * count is 0, with one tab it is 1, with two tabs it is 2.
 */

type Listener = {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  lastSeen: number;
};

const listeners = new Map<string, Listener>();

const HEARTBEAT_MS = 10_000;   // server -> client keepalive
const LIVE_TTL_MS = 26_000;    // client must ping inside this window
const SWEEP_MS = 4_000;

const encoder = new TextEncoder();

function frame(selfId?: string): Uint8Array {
  return encoder.encode(
    `event: presence\ndata: ${JSON.stringify({
      count: listeners.size,
      ts: Date.now(),
      ...(selfId ? { id: selfId } : {}),
    })}\n\n`
  );
}

function broadcast(): void {
  const msg = frame();
  for (const [id, l] of listeners) {
    try {
      l.controller.enqueue(msg);
    } catch {
      listeners.delete(id);
    }
  }
}

function sweep(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, l] of listeners) {
    if (now - l.lastSeen > LIVE_TTL_MS) {
      try {
        l.controller.close();
      } catch {
        /* already closed */
      }
      listeners.delete(id);
      changed = true;
    }
  }
  if (changed) broadcast();
}

// One sweeper for the process; unref so it never holds the process open.
let sweeper: ReturnType<typeof setInterval> | null = null;
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(sweep, SWEEP_MS);
  if (sweeper && "unref" in sweeper) (sweeper as { unref: () => void }).unref();
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET = subscribe to the live count. */
export async function GET(req: NextRequest): Promise<Response> {
  ensureSweeper();

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  let closed = false;
  let hb: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      listeners.set(id, { id, controller, lastSeen: Date.now() });

      try {
        controller.enqueue(encoder.encode("retry: 3000\n\n"));
        controller.enqueue(frame(id));
      } catch {
        listeners.delete(id);
        return;
      }
      broadcast();

      hb = setInterval(() => {
        const me = listeners.get(id);
        if (!me) return;
        try {
          me.controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          listeners.delete(id);
          broadcast();
        }
      }, HEARTBEAT_MS);
      if (hb && "unref" in hb) (hb as { unref: () => void }).unref();

      const drop = () => {
        if (closed) return;
        closed = true;
        if (hb) clearInterval(hb);
        listeners.delete(id);
        try {
          controller.close();
        } catch {
          /* noop */
        }
        broadcast();
      };

      req.signal.addEventListener("abort", drop);
      // Some runtimes surface the disconnect on the stream's cancel only.
      (controller as unknown as { __drop?: () => void }).__drop = drop;
    },
    cancel() {
      if (closed) return;
      closed = true;
      if (hb) clearInterval(hb);
      listeners.delete(id);
      broadcast();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** POST = heartbeat from an existing stream, so abrupt disconnects age out fast. */
export async function POST(req: NextRequest): Promise<Response> {
  let id = "";
  try {
    const body = (await req.json()) as { id?: string };
    id = body.id ?? "";
  } catch {
    id = req.nextUrl.searchParams.get("id") ?? "";
  }
  const l = id ? listeners.get(id) : undefined;
  if (l) l.lastSeen = Date.now();
  return Response.json(
    { ok: Boolean(l), count: listeners.size },
    { headers: { "Cache-Control": "no-store" } }
  );
}
