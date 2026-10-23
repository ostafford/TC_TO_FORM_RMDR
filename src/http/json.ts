/*
 * Copied from EH_Webhook (~/IDP/EH_Webhook/src/http/json.ts at 0c5ec92),
 * with DELETE added for Reminder Tasks (#27) and a per-call timeout (#33).
 * Never import it from the sibling project: this repo installs on its own
 * (spec #19, user story 71).
 */
/**
 * One JSON-over-HTTP call, with the response sorted into the four buckets every
 * caller in this project cares about. Shared by the Employment Hero and
 * Connecteam clients. `fetchImpl` is injectable for tests.
 */
export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export type HttpResponse =
  | { kind: "success"; status: number; body: unknown; headers: Headers }
  | { kind: "validation"; status: number; body: unknown; headers: Headers }
  | { kind: "client_error"; status: number; body: unknown; headers: Headers }
  | { kind: "retryable"; status: number | null; detail: string };

/**
 * How long one call may take, response body included, before it counts as a
 * timeout (`retryable`, status `null`). Well inside a cron run's 5-minute
 * lease, so a hung call can't outlive the run's hold on its Shift (#31).
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

export async function httpJson(
  req: HttpRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HttpResponse> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Raced as well as passed on, so a fetch that ignores the signal still times out.
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  try {
    const r = await Promise.race([call(req, fetchImpl, abort.signal), timedOut]);
    return r === "timeout" ? { kind: "retryable", status: null, detail: `timed out after ${timeoutMs / 1000} s` } : r;
  } finally {
    clearTimeout(timer);
  }
}

async function call(req: HttpRequest, fetchImpl: typeof fetch, signal: AbortSignal): Promise<HttpResponse> {
  const init: RequestInit = {
    signal,
    method: req.method,
    headers: {
      accept: "application/json",
      ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
      ...req.headers,
    },
  };
  if (req.body !== undefined) init.body = JSON.stringify(req.body);

  let res: Response;
  try {
    res = await fetchImpl(req.url, init);
  } catch (err) {
    return { kind: "retryable", status: null, detail: err instanceof Error ? err.message : String(err) };
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return { kind: "retryable", status: null, detail: err instanceof Error ? err.message : String(err) };
  }
  const body = text ? safeParse(text) : null;
  const headers = res.headers;

  if (res.ok) return { kind: "success", status: res.status, body, headers };
  if (res.status === 422) return { kind: "validation", status: res.status, body, headers };
  if (res.status === 429 || res.status >= 500) {
    return { kind: "retryable", status: res.status, detail: text.slice(0, 300) };
  }
  return { kind: "client_error", status: res.status, body, headers };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
