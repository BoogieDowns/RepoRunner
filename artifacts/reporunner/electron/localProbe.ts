import http from "node:http";
import net from "node:net";
import {
  PROBE_DEADLINES,
  PROBE_MAX_HEADER_BYTES,
  acceptableHeaders,
  buildProbeRequest,
  checkProbeBody,
  resultForStatus,
  type ProbeDeadlines,
  type ProbeRequest,
  type ProbeResult,
} from "../src/lib/ai/probeSpec.js";

/*
 * The local AI compatibility probe's transport (Stage 4N). Main process only,
 * and nothing calls it yet: no IPC handler, preload method, UI, startup code
 * or timer reaches it. Wiring it up needs its own authorization (Stage 4O).
 *
 * One call sends one request and settles once:
 * - The request comes from buildProbeRequest (src/lib/ai/probeSpec.ts), built
 *   here from the configuration: a canonical, validated loopback endpoint
 *   (127.0.0.1 or [::1], explicit port, validated base path) and one of the
 *   two fixed paths. A URL is never accepted.
 * - Node's http client over a socket this module opens itself: the literal
 *   address and family, a lookup function that refuses (no DNS), no agent
 *   (no proxy, no pooling, no keep-alive: Node writes straight to that
 *   socket), HTTP/1.1, no TLS, strict parsing,
 *   16 KiB of headers at most. Node's client follows no redirects and reads no
 *   proxy settings when given its own socket.
 * - Before the request bytes are written, the connected socket's remote
 *   address, port and family must be exactly the expected ones, and its local
 *   address loopback; otherwise nothing is sent ("address-mismatch").
 * - Exactly these headers, in order: Host, Accept, Accept-Encoding: identity,
 *   Connection: close, User-Agent. No body, cookie, credential or repository
 *   data. Nothing is read from the credential store or the settings file.
 * - The answer: anything but 200 gives a fixed result without reading the
 *   body; 200 needs a JSON content type and no compression, and the body is
 *   counted while it arrives and cut off one byte past the style's limit,
 *   then checked by checkProbeBody.
 * - Deadlines, each enforced by its own timer: connect 2 s, headers 3 s after
 *   connecting, 2 s between body chunks, 8 s overall. A caller may shorten
 *   them, never lengthen them. A caller-owned AbortSignal cancels at any point.
 * - When it settles, every timer is cleared, the abort listener removed, and
 *   the request and socket destroyed; later events change nothing. No retry,
 *   cache, global state, logging or file access. Concurrency limits belong to
 *   the future IPC service, not here.
 * - The result is a frozen fixed code (plus a status class or model count):
 *   never server text, headers, model names, paths or error messages.
 */

export interface ProbeOptions {
  /** Cancels the probe ("cancelled"). The probe never aborts the caller's controller. */
  signal?: AbortSignal;
  /** Shorter deadlines, for tests. A value above the default (or not a positive number) is ignored. */
  deadlines?: Partial<ProbeDeadlines>;
  /**
   * Test seam: opens the socket instead of net.connect. Whatever it returns
   * still has to pass the destination check before anything is written.
   * Production callers never pass it.
   */
  createSocket?: (request: ProbeRequest) => net.Socket;
}

/** Errors that mean nothing accepted the connection. */
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "ECONNRESET", "EADDRNOTAVAIL", "ENETUNREACH", "EHOSTUNREACH", "EAFNOSUPPORT"]);
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

/** The probe never resolves names; with a literal address this is never called. */
const refuseLookup = ((_host: string, _options: unknown, callback: (error: Error) => void) => {
  callback(Object.assign(new Error("name lookup refused"), { code: "ENOTFOUND" }));
}) as unknown as net.LookupFunction;

function limitsFrom(overrides: Partial<ProbeDeadlines> | undefined): ProbeDeadlines {
  const pick = (key: keyof ProbeDeadlines) => {
    const value = overrides?.[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, PROBE_DEADLINES[key]) : PROBE_DEADLINES[key];
  };
  return { connectMs: pick("connectMs"), headersMs: pick("headersMs"), idleMs: pick("idleMs"), totalMs: pick("totalMs") };
}

function resultForError(error: unknown, connected: boolean): ProbeResult {
  const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  if (code === "HPE_HEADER_OVERFLOW") return { outcome: "response-too-large" };
  if (code.startsWith("HPE_")) return { outcome: "incompatible-response" };
  if (!connected) return CONNECT_FAILURES.has(code) ? { outcome: "connection-refused" } : { outcome: "failed" };
  // The connection broke or closed before a complete answer.
  return { outcome: "incompatible-response" };
}

const noop = () => {};

/**
 * Probes a saved local AI configuration ({ endpoint, apiStyle }). Never
 * throws and never rejects: every outcome is a fixed result.
 */
export function probeLocalEndpoint(config: unknown, options: ProbeOptions = {}): Promise<ProbeResult> {
  const built = buildProbeRequest(config);
  if (!built.ok) return Promise.resolve(Object.freeze({ outcome: "invalid-request" as const }));
  const request = built.request;
  const signal = options.signal;
  if (signal?.aborted) return Promise.resolve(Object.freeze({ outcome: "cancelled" as const }));
  const limits = limitsFrom(options.deadlines);

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let connected = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let socket: net.Socket | null = null;
    let req: http.ClientRequest | null = null;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      signal?.removeEventListener("abort", onAbort);
      req?.destroy();
      socket?.destroy();
      resolve(Object.freeze(result));
    };
    const onAbort = () => finish({ outcome: "cancelled" });
    const timer = (ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        finish({ outcome: "timeout" });
      }, ms);
      timers.add(t);
      return t;
    };
    const cancelTimer = (t: ReturnType<typeof setTimeout> | null) => {
      if (t === null) return;
      clearTimeout(t);
      timers.delete(t);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    timer(limits.totalMs);
    const connectTimer = timer(limits.connectMs);
    let headersTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      socket = options.createSocket
        ? options.createSocket(request)
        : net.connect({ host: request.host, port: request.port, family: request.family, lookup: refuseLookup });
    } catch {
      finish({ outcome: "failed" });
      return;
    }
    const sock = socket;
    // Errors arrive through the request; this only keeps a late one from going unhandled.
    sock.on("error", noop);
    // Registered before the http client queues its write, so it runs first:
    // on a mismatch the socket is destroyed before a byte is sent.
    sock.once("connect", () => {
      if (settled) return;
      connected = true;
      cancelTimer(connectTimer);
      const family = request.family === 6 ? "IPv6" : "IPv4";
      if (sock.remoteAddress !== request.host || sock.remotePort !== request.port || sock.remoteFamily !== family || !LOOPBACK.has(sock.localAddress ?? "")) {
        finish({ outcome: "address-mismatch" });
        return;
      }
      headersTimer = timer(limits.headersMs);
    });

    try {
      req = http.request({
        method: request.method,
        path: request.path,
        // Raw [name, value, ...] form: sent exactly, in this order.
        headers: request.headers.flat() as string[],
        setHost: false,
        // No agent at all: with createConnection and no agent, Node writes to
        // this socket directly. (agent: false would create a fresh Agent,
        // which ignores createConnection and opens its own connection.)
        agent: undefined,
        createConnection: () => sock,
        lookup: refuseLookup,
        insecureHTTPParser: false,
        maxHeaderSize: PROBE_MAX_HEADER_BYTES,
      });
    } catch {
      finish({ outcome: "failed" });
      return;
    }
    const r = req;
    r.on("error", (error) => finish(resultForError(error, connected)));
    // A protocol switch (101) is not an answer; the socket is never handed over.
    r.on("upgrade", (_res, upgraded: net.Socket) => {
      upgraded.destroy();
      finish({ outcome: "incompatible-response" });
    });
    r.on("response", (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      cancelTimer(headersTimer);
      res.on("error", noop);
      const early = resultForStatus(res.statusCode ?? 0);
      if (early) {
        finish(early);
        return;
      }
      if (!acceptableHeaders(res.headers["content-type"], res.headers["content-encoding"])) {
        finish({ outcome: "incompatible-response" });
        return;
      }
      const declared = res.headers["content-length"];
      if (declared !== undefined && (!/^\d{1,15}$/.test(declared) || Number(declared) > request.maxBodyBytes)) {
        finish(/^\d{1,15}$/.test(declared) ? { outcome: "response-too-large" } : { outcome: "incompatible-response" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const resetIdle = () => {
        cancelTimer(idleTimer);
        idleTimer = timer(limits.idleMs);
      };
      resetIdle();
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > request.maxBodyBytes) {
          finish({ outcome: "response-too-large" });
          return;
        }
        chunks.push(chunk);
        resetIdle();
      });
      res.on("end", () => {
        if (settled) return;
        finish(checkProbeBody(request.apiStyle, Buffer.concat(chunks, size)));
      });
      res.on("close", () => {
        if (!res.complete) finish({ outcome: "incompatible-response" });
      });
    });
    r.end();
  });
}
