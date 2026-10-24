/**
 * Where the relay keeps each Deployment's last check-in (#35): one
 * SQLite-backed Durable Object for every client, so the relay's config needs
 * no account-specific id (see ../../CLAUDE.md, "Keep each deployment's values
 * in a git-ignored file"). Check-ins arrive once a day per Deployment, so one
 * instance is plenty.
 */
import { DurableObject } from "cloudflare:workers";
import type { CheckInRecord, CheckInStore } from "./types.js";

const PREFIX = "client:";

export class CheckIns extends DurableObject implements CheckInStore {
  async get(client: string): Promise<CheckInRecord | null> {
    return (await this.ctx.storage.get<CheckInRecord>(PREFIX + client)) ?? null;
  }

  async set(client: string, record: CheckInRecord): Promise<void> {
    await this.ctx.storage.put(PREFIX + client, record);
  }

  async all(): Promise<Record<string, CheckInRecord>> {
    const rows = await this.ctx.storage.list<CheckInRecord>({ prefix: PREFIX });
    return Object.fromEntries([...rows].map(([k, v]) => [k.slice(PREFIX.length), v]));
  }
}

/** The one instance every request and the cron share. */
export function checkInStore(ns: DurableObjectNamespace<CheckIns>): CheckInStore {
  return ns.get(ns.idFromName("check-ins")) as unknown as CheckInStore;
}
