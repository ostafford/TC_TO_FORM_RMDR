/*
 * Copied from EH_Webhook (~/IDP/EH_Webhook/src/connecteam/client.ts at
 * 0c5ec92) and adapted: the onboarding and pay-rate calls are dropped, and the
 * form calls this project needs are added. The result-object contract is kept:
 * nothing here throws on a 429, 5xx or timeout, so every caller must check
 * `outcome` (playbook, ../CLAUDE.md). Never import it from the sibling project.
 */
/**
 * Connecteam API client. Auth is the `X-API-KEY` header.
 *
 *  - GET  /users/v1/users?userIds={id}                     (no single-user GET)
 *  - GET  /users/v1/users?limit=500&offset={n}             (active users, paged)
 *  - GET  /forms/v1/forms/{formId}
 *  - GET  /forms/v1/forms/{formId}/form-submissions        (Unix-second window)
 *  - GET  /chat/v1/conversations
 *  - POST /chat/v1/conversations/privateMessage/{userId}   body { senderId, text }
 *  - POST /chat/v1/conversations/{conversationId}/message  body { senderId, text }
 *  - rate limit headers: x-ratelimit-minute-remaining / -limit, -day-remaining
 */
import { httpJson, type HttpResponse } from "../http/json.js";
import type {
  Conversation,
  CtResult,
  ConnecteamUser,
  Form,
  FormSubmission,
  RateLimit,
} from "./types.js";

export interface CtClientConfig {
  apiKey: string;
  /** Custom publisher id (from Settings -> Feed settings). Required to send chat. */
  customPublisherId: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://api.connecteam.com";
const MAX_TEXT = 500;
/** The most users one `GET /users/v1/users` page returns. */
const USERS_PAGE = 500;
/** The most submissions one `form-submissions` call returns. */
const SUBMISSIONS_PAGE = 100;

export class ConnecteamClient {
  readonly #base: string;
  readonly #apiKey: string;
  readonly #publisherId: number;
  readonly #fetch: typeof fetch;

  /** Rate-limit headers from the most recent call, for callers that back off. */
  lastRateLimit: RateLimit | null = null;

  constructor(cfg: CtClientConfig) {
    this.#base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.#apiKey = cfg.apiKey;
    this.#publisherId = cfg.customPublisherId;
    this.#fetch = cfg.fetchImpl ?? fetch;
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<HttpResponse> {
    const r = await httpJson(
      { method, url: `${this.#base}${path}`, headers: { "X-API-KEY": this.#apiKey }, body },
      this.#fetch,
    );
    if (r.kind !== "retryable") this.lastRateLimit = readRateLimit(r.headers);
    return r;
  }

  async getUser(userId: number): Promise<CtResult<ConnecteamUser | null>> {
    const r = await this.#call("GET", `/users/v1/users?userIds=${userId}&limit=1&offset=0`);
    return unwrap(r, (b) => {
      const users = (b as Wrapped<{ users: ConnecteamUser[] }>).data.users;
      return users.find((u) => u.userId === userId) ?? null;
    });
  }

  /**
   * Every active user (Connecteam's default `userStatus`), paged 500 at a
   * time: one call for most accounts. There is no `userType` filter, so
   * callers filter on their side (#5).
   */
  async listActiveUsers(): Promise<CtResult<ConnecteamUser[]>> {
    const all: ConnecteamUser[] = [];
    for (let offset = 0; ; offset += USERS_PAGE) {
      const r = await this.#call("GET", `/users/v1/users?limit=${USERS_PAGE}&offset=${offset}`);
      const page = unwrap(r, (b) => {
        const users = (b as Wrapped<{ users: ConnecteamUser[] }>).data.users;
        if (!Array.isArray(users)) throw new Error("no users");
        return users;
      });
      if (page.outcome !== "ok") return page;
      all.push(...page.data);
      if (page.data.length < USERS_PAGE) return { outcome: "ok", data: all };
    }
  }

  async getForm(formId: number): Promise<CtResult<Form>> {
    const r = await this.#call("GET", `/forms/v1/forms/${formId}`);
    return unwrap(r, (b) => {
      const form = (b as Wrapped<Form>).data;
      if (typeof form.formName !== "string") throw new Error("no formName");
      return form;
    });
  }

  /**
   * The user's submissions of a form submitted inside a window.
   * Both bounds are Unix seconds, the time clock's unit (#3), inclusive, and
   * filter on the submitted time. One call: up to 100, far more than one user
   * submits in one Shift's window, so the caller can skip any already credited
   * to another Shift (#26).
   */
  async listFormSubmissions(
    formId: number,
    query: { userId: number; fromSeconds: number; toSeconds: number },
  ): Promise<CtResult<FormSubmission[]>> {
    const qs =
      `userIds=${query.userId}` +
      `&submittingStartTimestamp=${query.fromSeconds}` +
      `&submittingEndTime=${query.toSeconds}` +
      `&limit=${SUBMISSIONS_PAGE}`;
    const r = await this.#call("GET", `/forms/v1/forms/${formId}/form-submissions?${qs}`);
    return unwrap(r, (b) => {
      const rows = (b as Wrapped<{ formSubmissions: FormSubmission[] }>).data.formSubmissions;
      if (!Array.isArray(rows)) throw new Error("no formSubmissions");
      return rows;
    });
  }

  async listConversations(): Promise<CtResult<Conversation[]>> {
    const r = await this.#call("GET", `/chat/v1/conversations`);
    return unwrap(r, (b) => (b as Wrapped<{ conversations: Conversation[] }>).data.conversations);
  }

  /** DM a user as the custom publisher. Text is clamped to 500 chars. */
  async sendDirectMessage(userId: number, text: string): Promise<CtResult<null>> {
    const r = await this.#call("POST", `/chat/v1/conversations/privateMessage/${userId}`, {
      senderId: this.#publisherId,
      text: clamp(text),
    });
    return unwrap(r, () => null);
  }

  /** Post to a team/channel conversation as the custom publisher. */
  async sendChannelMessage(conversationId: string, text: string): Promise<CtResult<null>> {
    const r = await this.#call("POST", `/chat/v1/conversations/${conversationId}/message`, {
      senderId: this.#publisherId,
      text: clamp(text),
    });
    return unwrap(r, () => null);
  }
}

interface Wrapped<T> {
  requestId: string;
  data: T;
}

function clamp(text: string): string {
  const t = text.trim();
  return t.length <= MAX_TEXT ? t : `${t.slice(0, MAX_TEXT - 1)}…`;
}

function readRateLimit(h: Headers): RateLimit {
  const num = (name: string): number | null => {
    const v = h.get(name);
    return v === null || v === "" ? null : Number(v);
  };
  return {
    minuteRemaining: num("x-ratelimit-minute-remaining"),
    minuteLimit: num("x-ratelimit-minute-limit"),
    dayRemaining: num("x-ratelimit-day-remaining"),
  };
}

function unwrap<T>(r: HttpResponse, pick: (body: unknown) => T): CtResult<T> {
  switch (r.kind) {
    case "success":
      try {
        return { outcome: "ok", data: pick(r.body) };
      } catch {
        return { outcome: "error", status: r.status, detail: "unexpected response shape" };
      }
    case "retryable":
      return { outcome: "retryable", status: r.status, detail: r.detail };
    case "validation":
    case "client_error":
      return {
        outcome: "error",
        status: r.status,
        detail: typeof r.body === "string" ? r.body : JSON.stringify(r.body).slice(0, 300),
      };
  }
}
