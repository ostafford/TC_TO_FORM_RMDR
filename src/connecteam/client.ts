/*
 * Copied from EH_Webhook (~/IDP/EH_Webhook/src/connecteam/client.ts at
 * 0c5ec92) and adapted: the onboarding and pay-rate calls are dropped, and the
 * form and Quick Task calls this project needs are added. The result-object contract is kept:
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
 *  - GET  /time-clock/v1/time-clocks
 *  - GET  /time-clock/v1/time-clocks/{id}/time-activities  (date window, no paging)
 *  - GET  /chat/v1/conversations
 *  - POST /chat/v1/conversations/privateMessage/{userId}   body { senderId, text }
 *  - POST /chat/v1/conversations/{conversationId}/message  body { senderId, text }
 *  - POST   /tasks/v1/taskboards/{boardId}/tasks           (returns the new task's `id`)
 *  - PUT    /tasks/v1/taskboards/{boardId}/tasks/{taskId}  (a full replace: complete or reopen)
 *  - DELETE /tasks/v1/taskboards/{boardId}/tasks/{taskId}
 *  - rate limit headers: x-ratelimit-minute-remaining / -limit, -day-remaining / -limit
 */
import { DEFAULT_TIMEOUT_MS, httpJson, type HttpResponse } from "../http/json.js";
import type {
  Conversation,
  CtResult,
  ConnecteamUser,
  Form,
  FormSubmission,
  RateLimit,
  TimeActivity,
  TimeClock,
  UserTimeActivities,
} from "./types.js";

export interface CtClientConfig {
  apiKey: string;
  /** Custom publisher id (from Settings -> Feed settings). Required to send chat. */
  customPublisherId: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per-call timeout; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

const DEFAULT_BASE = "https://api.connecteam.com";
const MAX_TEXT = 500;
/** The most users one `GET /users/v1/users` page returns. */
const USERS_PAGE = 500;
/** The most submissions one `form-submissions` call returns. */
const SUBMISSIONS_PAGE = 100;
/** Stop for the minute once less than this share of the per-minute limit remains (ADR-0002). */
const MINUTE_HEADROOM = 0.2;

export class ConnecteamClient {
  readonly #base: string;
  readonly #apiKey: string;
  readonly #publisherId: number;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  /** Rate-limit headers from the most recent call, for callers that back off. */
  lastRateLimit: RateLimit | null = null;
  #saw429 = false;
  /** A call came back 401 or 403: Connecteam rejected the API key (#34). */
  keyRejected = false;
  /** Settings found pointing at something gone this run: a 404 on the Compliance Form, the publisher or the task board (#34). */
  readonly gone = new Set<"form" | "publisher" | "board">();

  constructor(cfg: CtClientConfig) {
    this.#base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.#apiKey = cfg.apiKey;
    this.#publisherId = cfg.customPublisherId;
    this.#fetch = cfg.fetchImpl ?? fetch;
    this.#timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async #call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<HttpResponse> {
    const r = await httpJson(
      { method, url: `${this.#base}${path}`, headers: { "X-API-KEY": this.#apiKey }, body },
      this.#fetch,
      this.#timeoutMs,
    );
    if (r.kind !== "retryable") this.lastRateLimit = readRateLimit(r.headers);
    else if (r.status === 429) this.#saw429 = true;
    if (r.kind === "client_error" && (r.status === 401 || r.status === 403)) this.keyRejected = true;
    return r;
  }

  /**
   * Whether the run should stop calling (#31, #34): the minute's budget is
   * spent, or Connecteam rejected the API key.
   */
  stopped(): boolean {
    return this.keyRejected || this.minuteBudgetSpent();
  }

  /**
   * Whether the caller should stop calling for the rest of this minute (#31):
   * a 429 came back, or the last response left less than 20% of the
   * per-minute limit, which the account shares with its other integrations.
   * A client lives for one cron run, so this clears each minute.
   */
  minuteBudgetSpent(): boolean {
    if (this.#saw429) return true;
    const rl = this.lastRateLimit;
    return !!rl && rl.minuteRemaining !== null && rl.minuteLimit !== null && rl.minuteRemaining < rl.minuteLimit * MINUTE_HEADROOM;
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

  /** A 404 notes the form as gone (#34). */
  async getForm(formId: number): Promise<CtResult<Form>> {
    const r = await this.#call("GET", `/forms/v1/forms/${formId}`);
    if (r.kind === "client_error" && r.status === 404) this.gone.add("form");
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

  /** Every time clock, archived ones included. */
  async listTimeClocks(): Promise<CtResult<TimeClock[]>> {
    const r = await this.#call("GET", `/time-clock/v1/time-clocks`);
    return unwrap(r, (b) => {
      const clocks = (b as Wrapped<{ timeClocks: TimeClock[] }>).data.timeClocks;
      if (!Array.isArray(clocks)) throw new Error("no timeClocks");
      return clocks;
    });
  }

  /**
   * One time clock's Shift Segments and manual breaks between two dates
   * (`YYYY-MM-DD`, inclusive), by user. One call: the endpoint isn't paged.
   * `end` is left out or `null` while a record is open. A record without an
   * id or a start is dropped rather than failing the rest.
   */
  async listTimeActivities(timeClockId: number, startDate: string, endDate: string): Promise<CtResult<UserTimeActivities[]>> {
    const r = await this.#call(
      "GET",
      `/time-clock/v1/time-clocks/${timeClockId}/time-activities?startDate=${startDate}&endDate=${endDate}`,
    );
    return unwrap(r, (b) => {
      const users = (b as Wrapped<{ timeActivitiesByUsers: unknown[] }>).data.timeActivitiesByUsers;
      if (!Array.isArray(users)) throw new Error("no timeActivitiesByUsers");
      return users.flatMap((u) => {
        const o = asObject(u);
        if (!o || typeof o.userId !== "number") return [];
        return [{ userId: o.userId, shifts: records(o.shifts), manualBreaks: records(o.manualBreaks) }];
      });
    });
  }

  async listConversations(): Promise<CtResult<Conversation[]>> {
    const r = await this.#call("GET", `/chat/v1/conversations`);
    return unwrap(r, (b) => (b as Wrapped<{ conversations: Conversation[] }>).data.conversations);
  }

  /** DM a user as the custom publisher. Text is clamped to 500 chars. Notes a missing publisher (#34). */
  async sendDirectMessage(userId: number, text: string): Promise<CtResult<null>> {
    const r = await this.#call("POST", `/chat/v1/conversations/privateMessage/${userId}`, {
      senderId: this.#publisherId,
      text: clamp(text),
    });
    this.#notePublisher(r);
    return unwrap(r, () => null);
  }

  /**
   * A missing publisher answers 404 "Sender id not found", checked before the
   * recipient or conversation, so any other 404 is about them (tested live
   * 2026-10-24, int_MCP research/2026-10-24-error-responses-for-missing-settings.md).
   */
  #notePublisher(r: HttpResponse): void {
    if (r.kind === "client_error" && r.status === 404 && detailOf(r.body) === "Sender id not found") this.gone.add("publisher");
  }

  /**
   * Create a published Quick Task. One user makes an individual task (two or
   * more would make one group task). Not idempotent: a repeat makes a second
   * task, so the caller stores the returned id before anything could repeat it.
   * Notes a missing board (#34): a 400 saying the board id was "not found in
   * course_modules", not a 404 (tested live 2026-10-24, as above).
   */
  async createTask(boardId: string, task: QuickTask): Promise<CtResult<{ id: string }>> {
    const r = await this.#call("POST", `/tasks/v1/taskboards/${encodeURIComponent(boardId)}/tasks`, {
      userIds: task.userIds,
      status: "published",
      title: task.title,
      description: { content: task.description },
    });
    if (r.kind === "client_error" && r.status === 400 && /not found in course_modules/.test(errorOf(r.body))) this.gone.add("board");
    return unwrap(r, (b) => {
      const id = (b as Wrapped<{ id: string }>).data.id;
      if (typeof id !== "string" || !id) throw new Error("no task id");
      return { id };
    });
  }

  /**
   * Mark a Quick Task `completed`. The `PUT` is a full replace, so the task's
   * title, users and description go again as they were created. Safe to
   * repeat. A 404 means the task never existed; a deleted one still answers
   * 200 and stays deleted (tested live 2026-10-24, #28).
   */
  async completeTask(boardId: string, taskId: string, task: QuickTask): Promise<CtResult<null>> {
    return this.#putTask(boardId, taskId, task, "completed");
  }

  /**
   * Set a completed Quick Task back to `published`, as {@link completeTask}
   * does the other way. The assignee gets a push notification, and no
   * webhook fires (tested live 2026-10-24, #28).
   */
  async reopenTask(boardId: string, taskId: string, task: QuickTask): Promise<CtResult<null>> {
    return this.#putTask(boardId, taskId, task, "published");
  }

  async #putTask(boardId: string, taskId: string, task: QuickTask, status: "published" | "completed"): Promise<CtResult<null>> {
    const r = await this.#call(
      "PUT",
      `/tasks/v1/taskboards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}`,
      { userIds: task.userIds, status, title: task.title, description: { content: task.description } },
    );
    return unwrap(r, () => null);
  }

  /** Delete a Quick Task. A 404 means it was already gone. */
  async deleteTask(boardId: string, taskId: string): Promise<CtResult<null>> {
    const r = await this.#call(
      "DELETE",
      `/tasks/v1/taskboards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}`,
    );
    return unwrap(r, () => null);
  }

  /** Post to a team/channel conversation as the custom publisher. */
  async sendChannelMessage(conversationId: string, text: string): Promise<CtResult<null>> {
    const r = await this.#call("POST", `/chat/v1/conversations/${conversationId}/message`, {
      senderId: this.#publisherId,
      text: clamp(text),
    });
    this.#notePublisher(r);
    return unwrap(r, () => null);
  }
}

/** The fields a Reminder Task is created with, and sent again on every `PUT`. */
export interface QuickTask {
  title: string;
  userIds: number[];
  description: string;
}

interface Wrapped<T> {
  requestId: string;
  data: T;
}

/** An error body's `detail` (most of the API) or `error` (Quick Tasks), or blank. */
function detailOf(body: unknown): string {
  const o = asObject(body);
  return typeof o?.detail === "string" ? o.detail : "";
}

function errorOf(body: unknown): string {
  const o = asObject(body);
  return typeof o?.error === "string" ? o.error : "";
}

function clamp(text: string): string {
  const t = text.trim();
  return t.length <= MAX_TEXT ? t : `${t.slice(0, MAX_TEXT - 1)}…`;
}

function records(v: unknown): TimeActivity[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((r) => {
    const o = asObject(r);
    const start = punch(o?.start);
    if (!o || typeof o.id !== "string" || !o.id || !start) return [];
    const a: TimeActivity = { id: o.id, start };
    const end = punch(o.end);
    if (end) a.end = end;
    if (typeof o.schedulerShiftId === "string" && o.schedulerShiftId) a.schedulerShiftId = o.schedulerShiftId;
    if (typeof o.isAutoClockOut === "boolean") a.isAutoClockOut = o.isAutoClockOut;
    if (typeof o.modifiedAt === "number") a.modifiedAt = o.modifiedAt;
    return [a];
  });
}

function punch(v: unknown): TimeActivity["start"] | null {
  const p = asObject(v);
  if (!p || typeof p.timestamp !== "number" || typeof p.timezone !== "string") return null;
  return { timestamp: p.timestamp, timezone: p.timezone };
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
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
    dayLimit: num("x-ratelimit-day-limit"),
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
