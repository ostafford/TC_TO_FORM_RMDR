/**
 * A fake Connecteam behind the real `ConnecteamClient`. It records every call
 * and answers like the API does: users (by id, or every active user paged),
 * forms, form submissions filtered by
 * user and an inclusive submitted-time window, DMs, and Quick Tasks (create,
 * a full-replace update, delete; 404 for a task that never existed, and a
 * `PUT` on a deleted one answers 200 and changes nothing, as live), and time
 * clocks with their records for the sweep (#32). A scripted reply
 * (`failNext`) answers the next matching call instead, and a stalled one
 * (`stallNext`) answers only when the test lets it go, as a run that dies
 * mid-call never hears back (#31). `failAll` keeps answering matching calls
 * with a status until `recover()`, as an outage does, and a status of `null`
 * drops the connection instead, as a timeout does (#33). Channel posts (the
 * Failure Alerts) land in `posts`.
 *
 * The sweep's time-clock reads go to `sweepCalls`, not `calls`, so `calls`
 * stays "what the Worker did about a Shift" for tests that aren't about the sweep.
 */
export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface FakeUser {
  userId: number;
  firstName: string;
  lastName: string;
  /** `user` (the default), or `manager` / `owner` for an Admin. */
  userType?: string;
  isArchived?: boolean;
  /** The user's direct manager, as the `directManager` custom field's value. */
  directManager?: unknown;
}

export interface FakeSubmission {
  formSubmissionId: string;
  formId: number;
  submittingUserId: number;
  submissionTimestamp: number;
  answers?: unknown[];
}

export interface FakeTask {
  id: string;
  boardId: string;
  userIds: number[];
  status: string;
  title: string;
  description?: { content: string };
}

/** A Shift Segment or manual break as `GET .../time-activities` returns it. */
export interface FakeRecord {
  timeClockId: number;
  userId: number;
  kind: "shift" | "manual_break";
  id: string;
  start: number;
  end?: number;
  modifiedAt: number;
  timezone?: string;
}

export interface SentDm {
  userId: number;
  senderId: number;
  text: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeConnecteam {
  readonly calls: RecordedCall[] = [];
  /** The sweep's reads: `GET /time-clock/...`. */
  readonly sweepCalls: RecordedCall[] = [];
  readonly timeClocks: { id: number; name: string; isArchived: boolean }[] = [];
  readonly records: FakeRecord[] = [];
  /** Sent as `x-ratelimit-day-limit` on every answer when set. */
  dayLimit: number | null = null;
  /** Sent as `x-ratelimit-minute-limit` / `-minute-remaining` on every answer when set. */
  minute: { limit: number; remaining: number } | null = null;
  readonly #stalls: Array<{ method: string; pathPrefix: string; reached: () => void; gate: Promise<number> }> = [];
  readonly dms: SentDm[] = [];
  readonly posts: { conversationId: string; senderId: number; text: string }[] = [];
  readonly #outages: Array<{ method: string; pathPrefix: string; status: number | null }> = [];
  readonly users = new Map<number, FakeUser>();
  readonly forms = new Map<number, string>();
  readonly submissions: FakeSubmission[] = [];
  /** Quick Tasks that exist now, by id. */
  readonly tasks = new Map<string, FakeTask>();
  readonly #deletedTasks = new Set<string>();
  #nextTask = 0;
  readonly #scripted: Array<{ method: string; pathPrefix: string; status: number | null }> = [];
  /** Runs while a DM is being sent, before it's answered: for racing a webhook against a send. */
  duringDm: ((userId: number) => Promise<void>) | null = null;

  addUser(u: FakeUser): this {
    this.users.set(u.userId, u);
    return this;
  }

  addForm(formId: number, formName: string): this {
    this.forms.set(formId, formName);
    return this;
  }

  submit(s: FakeSubmission): this {
    this.submissions.push(s);
    return this;
  }

  /** Answer the next call whose path starts with `pathPrefix` with this status; `null` drops the connection. */
  failNext(method: string, pathPrefix: string, status: number | null): this {
    this.#scripted.push({ method, pathPrefix, status });
    return this;
  }

  /** Answer every call whose path starts with `pathPrefix` with this status until {@link recover}; `null` drops the connection. */
  failAll(method: string, pathPrefix: string, status: number | null): this {
    this.#outages.push({ method, pathPrefix, status });
    return this;
  }

  /** End every {@link failAll}. */
  recover(): this {
    this.#outages.length = 0;
    return this;
  }

  /**
   * Hold the next call whose path starts with `pathPrefix` unanswered.
   * `reached` resolves once it's made; `release(status)` answers it.
   */
  stallNext(method: string, pathPrefix: string): { reached: Promise<void>; release: (status: number) => void } {
    let reached!: () => void;
    let release!: (status: number) => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    const gate = new Promise<number>((r) => (release = r));
    this.#stalls.push({ method, pathPrefix, reached, gate });
    return { reached: reachedP, release };
  }

  /** The calls to one path, e.g. `"/forms/v1/forms/9001/form-submissions"`. */
  callsTo(method: string, path: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => (query[key] = value));
    const call: RecordedCall = { method, path: url.pathname, query, body };
    (url.pathname.startsWith("/time-clock/") ? this.sweepCalls : this.calls).push(call);

    const stall = this.#stalls.findIndex((s) => s.method === method && url.pathname.startsWith(s.pathPrefix));
    if (stall !== -1) {
      const [s] = this.#stalls.splice(stall, 1);
      s!.reached();
      return json(await s!.gate, { detail: "released stall" });
    }
    const i = this.#scripted.findIndex((s) => s.method === method && url.pathname.startsWith(s.pathPrefix));
    const failure =
      i !== -1 ? this.#scripted.splice(i, 1)[0]! : this.#outages.find((s) => s.method === method && url.pathname.startsWith(s.pathPrefix));
    if (failure) {
      if (failure.status === null) throw new TypeError("Network connection lost.");
      return json(failure.status, { detail: "scripted failure" });
    }
    const dm = method === "POST" && url.pathname.match(/^\/chat\/v1\/conversations\/privateMessage\/(\d+)$/);
    if (dm && this.duringDm) {
      const hook = this.duringDm;
      this.duringDm = null;
      await hook(Number(dm[1]));
    }
    const res = this.#answer(call);
    if (this.dayLimit !== null) res.headers.set("x-ratelimit-day-limit", String(this.dayLimit));
    if (this.minute !== null) {
      res.headers.set("x-ratelimit-minute-limit", String(this.minute.limit));
      res.headers.set("x-ratelimit-minute-remaining", String(this.minute.remaining));
    }
    return res;
  }) as typeof fetch;

  addTimeClock(id: number, isArchived = false): this {
    this.timeClocks.push({ id, name: `Clock ${id}`, isArchived });
    return this;
  }

  addRecord(r: FakeRecord): this {
    this.records.push(r);
    return this;
  }

  #answer({ method, path, query, body }: RecordedCall): Response {
    if (method === "GET" && path === "/users/v1/users") {
      const all = [...this.users.values()];
      // Connecteam's default userStatus is `active`; asking by id finds archived users too.
      const matched = query.userIds
        ? all.filter((u) => query.userIds!.split(",").map(Number).includes(u.userId))
        : all.filter((u) => !u.isArchived);
      const offset = Number(query.offset ?? 0);
      const page = matched.slice(offset, offset + Number(query.limit ?? 10));
      const users = page.map(({ directManager, ...u }) => ({
        userType: "user",
        ...u,
        customFields:
          directManager === undefined
            ? []
            : [{ customFieldId: 25145114, name: "Direct manager", type: "directManager", value: directManager }],
      }));
      return json(200, { requestId: "r", data: { users }, paging: { offset: offset + users.length } });
    }

    const subs = path.match(/^\/forms\/v1\/forms\/(\d+)\/form-submissions$/);
    if (method === "GET" && subs) {
      const formId = Number(subs[1]);
      const userIds = (query.userIds ?? "").split(",").filter(Boolean).map(Number);
      const from = query.submittingStartTimestamp === undefined ? -Infinity : Number(query.submittingStartTimestamp);
      const to = query.submittingEndTime === undefined ? Infinity : Number(query.submittingEndTime);
      const limit = Number(query.limit ?? 10);
      const rows = this.submissions
        .filter(
          (s) =>
            s.formId === formId &&
            (userIds.length === 0 || userIds.includes(s.submittingUserId)) &&
            s.submissionTimestamp >= from &&
            s.submissionTimestamp <= to,
        )
        .slice(0, limit);
      return json(200, { requestId: "r", data: { formSubmissions: rows }, paging: { offset: rows.length } });
    }

    const form = path.match(/^\/forms\/v1\/forms\/(\d+)$/);
    if (method === "GET" && form) {
      const name = this.forms.get(Number(form[1]));
      return name === undefined
        ? json(404, { detail: "form not found" })
        : json(200, { requestId: "r", data: { formId: Number(form[1]), formName: name } });
    }

    if (method === "GET" && path === "/time-clock/v1/time-clocks") {
      return json(200, { requestId: "r", data: { timeClocks: this.timeClocks } });
    }

    // Every record on the clock, whatever the dates: tests assert the dates asked for.
    const activities = path.match(/^\/time-clock\/v1\/time-clocks\/(\d+)\/time-activities$/);
    if (method === "GET" && activities) {
      const mine = this.records.filter((r) => r.timeClockId === Number(activities[1]));
      const byUser = new Map<number, { userId: number; shifts: unknown[]; manualBreaks: unknown[]; timeOffs: unknown[] }>();
      for (const r of mine) {
        const u = byUser.get(r.userId) ?? { userId: r.userId, shifts: [], manualBreaks: [], timeOffs: [] };
        byUser.set(r.userId, u);
        const tz = r.timezone ?? "Australia/Sydney";
        (r.kind === "shift" ? u.shifts : u.manualBreaks).push({
          id: r.id,
          start: { timestamp: r.start, timezone: tz },
          end: r.end === undefined ? null : { timestamp: r.end, timezone: tz },
          modifiedAt: r.modifiedAt,
          isAutoClockOut: false,
        });
      }
      return json(200, { requestId: "r", data: { timeActivitiesByUsers: [...byUser.values()] } });
    }

    const dm = path.match(/^\/chat\/v1\/conversations\/privateMessage\/(\d+)$/);
    if (method === "POST" && dm) {
      const b = body as { senderId: number; text: string };
      this.dms.push({ userId: Number(dm[1]), senderId: b.senderId, text: b.text });
      return json(200, { requestId: "r", data: {} });
    }

    const channel = path.match(/^\/chat\/v1\/conversations\/([^/]+)\/message$/);
    if (method === "POST" && channel) {
      const b = body as { senderId: number; text: string };
      this.posts.push({ conversationId: decodeURIComponent(channel[1]!), senderId: b.senderId, text: b.text });
      return json(200, { requestId: "r", data: {} });
    }

    const board = path.match(/^\/tasks\/v1\/taskboards\/([^/]+)\/tasks$/);
    if (method === "POST" && board) {
      const b = body as Omit<FakeTask, "id" | "boardId">;
      const id = `task-${++this.#nextTask}`;
      this.tasks.set(id, { ...b, id, boardId: decodeURIComponent(board[1]!) });
      return json(200, { requestId: "r", data: { id, userIds: b.userIds, status: b.status, title: b.title } });
    }

    const task = path.match(/^\/tasks\/v1\/taskboards\/([^/]+)\/tasks\/([^/]+)$/);
    if (task && (method === "PUT" || method === "DELETE")) {
      const boardId = decodeURIComponent(task[1]!);
      const id = decodeURIComponent(task[2]!);
      if (method === "PUT" && this.#deletedTasks.has(id)) return json(200, { requestId: "r", data: body });
      if (this.tasks.get(id)?.boardId !== boardId) return json(404, { detail: "Task not found" });
      if (method === "DELETE") {
        this.tasks.delete(id);
        this.#deletedTasks.add(id);
      }
      // A full replace: whatever isn't sent again is gone.
      else this.tasks.set(id, { ...(body as Omit<FakeTask, "id" | "boardId">), id, boardId });
      return json(200, { requestId: "r", data: {} });
    }

    throw new Error(`fake Connecteam: unmatched ${method} ${path}`);
  }
}
