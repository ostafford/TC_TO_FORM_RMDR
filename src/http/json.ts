/*
 * Copied from EH_Webhook (~/IDP/EH_Webhook/src/http/json.ts at 0c5ec92),
 * unchanged apart from this note. Never import it from the sibling project:
 * this repo installs on its own (spec #19, user story 71).
 */
/**
 * One JSON-over-HTTP call, with the response sorted into the four buckets every
 * caller in this project cares about. Shared by the Employment Hero and
 * Connecteam clients. `fetchImpl` is injectable for tests.
 */
export interface HttpRequest {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export type HttpResponse =
  | { kind: "success"; status: number; body: unknown; headers: Headers }
  | { kind: "validation"; status: number; body: unknown; headers: Headers }
  | { kind: "client_error"; status: number; body: unknown; headers: Headers }
  | { kind: "retryable"; status: number | null; detail: string };

export async function httpJson(
  req: HttpRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResponse> {
  const init: RequestInit = {
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

  const text = await res.text();
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
