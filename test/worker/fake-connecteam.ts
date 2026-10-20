/**
 * A fake Connecteam behind the real `ConnecteamClient`. It records every call
 * and answers like the API does: users (by id, or every active user paged),
 * forms, form submissions filtered by
 * user and an inclusive submitted-time window, and DMs. A scripted reply
 * (`failNext`) answers the next matching call instead.
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
  readonly dms: SentDm[] = [];
  readonly users = new Map<number, FakeUser>();
  readonly forms = new Map<number, string>();
  readonly submissions: FakeSubmission[] = [];
  readonly #scripted: Array<{ method: string; pathPrefix: string; status: number }> = [];

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

  /** Answer the next call whose path starts with `pathPrefix` with this status. */
  failNext(method: string, pathPrefix: string, status: number): this {
    this.#scripted.push({ method, pathPrefix, status });
    return this;
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
    this.calls.push(call);

    const i = this.#scripted.findIndex((s) => s.method === method && url.pathname.startsWith(s.pathPrefix));
    if (i !== -1) {
      const [s] = this.#scripted.splice(i, 1);
      return json(s!.status, { detail: "scripted failure" });
    }
    return this.#answer(call);
  }) as typeof fetch;

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

    const dm = path.match(/^\/chat\/v1\/conversations\/privateMessage\/(\d+)$/);
    if (method === "POST" && dm) {
      const b = body as { senderId: number; text: string };
      this.dms.push({ userId: Number(dm[1]), senderId: b.senderId, text: b.text });
      return json(200, { requestId: "r", data: {} });
    }

    throw new Error(`fake Connecteam: unmatched ${method} ${path}`);
  }
}
