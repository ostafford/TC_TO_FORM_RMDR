/**
 * Rerunning one setup step on a running Deployment (#41, #19 user stories 51
 * and 52): what the change affects, said before it's applied. The counts come
 * from the Deployment's D1 database (IMPACT_SQL, run with `wrangler d1
 * execute`); the lines are built here, pure, so the wording is tested without
 * a database.
 *
 * What each setting change does mid-flight follows the Worker (#19 "Settings
 * changes mid-flight", #17): Shifts in progress at a form switch accept
 * either form (`Store.noteComplianceForm`); steps already scheduled keep
 * their times; recipients, Quiet Hours, the "where to find it" phrase and
 * the publisher are read when each message is sent.
 */

/** What's in progress on the Deployment, as IMPACT_SQL counts it. */
export interface Counts {
  /** Shifts still needing a form: the ones a form switch lets accept either form. */
  needsForm: number;
  /** Shifts with a Reminder or Escalation already scheduled. */
  scheduled: number;
  /** Shifts not yet escalated, held ones included. */
  notEscalated: number;
  /** Escalations held for Quiet Hours. */
  held: number;
  /** Reminder Tasks not yet closed. */
  tasksOpen: number;
  /** Problems being reported in the Alerts Channel now. */
  alertsOpen: number;
}

/** The statuses match src/store.ts: NEEDS_FORM, and what `noteComplianceForm` updates. */
export const IMPACT_SQL = [
  "SELECT",
  "(SELECT COUNT(*) FROM shifts WHERE status IN ('open', 'grace', 'reminded', 'escalated') AND deleted_at IS NULL AND credited_submission_id IS NULL) AS needs_form,",
  "(SELECT COUNT(*) FROM shifts WHERE status IN ('grace', 'reminded') AND deleted_at IS NULL) AS scheduled,",
  "(SELECT COUNT(*) FROM shifts WHERE status IN ('open', 'grace', 'reminded') AND deleted_at IS NULL) AS not_escalated,",
  "(SELECT COUNT(*) FROM shifts WHERE held = 1 AND status = 'reminded' AND deleted_at IS NULL) AS held,",
  "(SELECT COUNT(*) FROM reminder_tasks WHERE state IN ('pending', 'open')) AS tasks_open,",
  "(SELECT COUNT(*) FROM failure_alerts WHERE state IN ('alerting', 'raised')) AS alerts_open",
].join(" ");

/** The counts from `wrangler d1 execute --json` output, or `null` when it can't be read. */
export function parseCounts(output: string): Counts | null {
  try {
    const start = output.indexOf("[");
    const row = (JSON.parse(output.slice(start)) as Array<{ results?: Array<Record<string, unknown>> }>)[0]?.results?.[0];
    if (!row) return null;
    const n = (k: string) => {
      const v = Number(row[k]);
      if (!Number.isInteger(v) || v < 0) throw new Error(k);
      return v;
    };
    return {
      needsForm: n("needs_form"),
      scheduled: n("scheduled"),
      notEscalated: n("not_escalated"),
      held: n("held"),
      tasksOpen: n("tasks_open"),
      alertsOpen: n("alerts_open"),
    };
  } catch {
    return null;
  }
}

/** The keys whose value differs between two `.dev.vars`, in `after`'s order then `before`'s. */
export function changedKeys(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])];
  return keys.filter((k) => (before[k] ?? "").trim() !== (after[k] ?? "").trim());
}

const shifts = (n: number) => (n === 1 ? "1 Shift is" : `${n} Shifts are`);
const changed = (keys: string[], ...of: string[]) => of.some((k) => keys.includes(k));

/**
 * What changing `keys` (from `before` to `after`) affects, one plain line
 * each. `counts` is `null` when the database couldn't be read: the lines then
 * say what changes without the numbers.
 */
export function impactLines(keys: string[], before: Record<string, string>, after: Record<string, string>, counts: Counts | null): string[] {
  const lines: string[] = [];
  const c = counts;
  if (changed(keys, "CT_API_KEY")) lines.push("The new key is used from the next check, within a minute.");
  if (changed(keys, "TIME_ZONE")) {
    lines.push(`Quiet hours follow the clock in ${after.TIME_ZONE} from the next check.`);
  }
  if (changed(keys, "COMPLIANCE_FORM_ID")) {
    if (!c) lines.push("Shifts in progress will accept either form; Shifts from now on need the new one.");
    else if (c.needsForm === 0) lines.push("No Shifts are in progress, so every Shift from now on needs the new form.");
    else lines.push(`${shifts(c.needsForm)} in progress. They'll accept either form; Shifts from now on need the new one.`);
  }
  if (changed(keys, "SHIFT_DATE_QUESTION_ID")) {
    lines.push(
      after.SHIFT_DATE_QUESTION_ID?.trim()
        ? "Submissions from now on count for the shift their date question names."
        : "Submissions from now on count by time: the shift they're made during or just after.",
    );
  }
  if (changed(keys, "WHERE_TO_FIND")) lines.push(`Messages from now on say: "Where: ${after.WHERE_TO_FIND ?? ""}"`);
  if (changed(keys, "GRACE_PERIOD_MINUTES", "ESCALATION_DELAY_MINUTES")) {
    const rest = "Everything scheduled from now on uses the new timings.";
    if (!c || c.scheduled === 0) lines.push(rest);
    else lines.push(`${shifts(c.scheduled)} waiting for a reminder or escalation already scheduled. Those keep their times. ${rest}`);
  }
  if (changed(keys, "QUIET_HOURS_ENABLED", "QUIET_HOURS_FROM", "QUIET_HOURS_UNTIL", "TIME_ZONE")) {
    const off = after.QUIET_HOURS_ENABLED === "false";
    const held = c?.held ?? 0;
    if (held > 0) {
      const them = held === 1 ? "1 escalation is held for quiet hours. It goes out" : `${held} escalations are held for quiet hours. They go out`;
      lines.push(off ? `${them} at the next check.` : `${them} when the new quiet hours end, or at the next check if it isn't quiet then.`);
    } else if (changed(keys, "QUIET_HOURS_ENABLED", "QUIET_HOURS_FROM", "QUIET_HOURS_UNTIL")) {
      lines.push(off ? "Escalations from now on go out at any hour." : "Escalations from now on follow the new quiet hours.");
    }
  }
  if (changed(keys, "EXCLUDED_ADMIN_IDS")) {
    const rest = "go to the new list of admins, plus the employee's direct manager.";
    if (!c || c.notEscalated === 0) lines.push(`Escalations from now on ${rest}`);
    else lines.push(`${shifts(c.notEscalated)} not escalated yet. If they are, their escalations ${rest}`);
  }
  if (changed(keys, "REMINDER_TASK_ENABLED", "TASK_BOARD_ID")) {
    const on = after.REMINDER_TASK_ENABLED === "true";
    lines.push(on ? (changed(keys, "TASK_BOARD_ID") ? "New reminder tasks go on the new board." : "Reminder tasks are made from the next reminder on.") : "No new reminder tasks from now on.");
    const open = c?.tasksOpen ?? 0;
    if (open > 0) {
      const them = open === 1 ? "1 reminder task is open. It still ticks itself off" : `${open} reminder tasks are open. They still tick themselves off`;
      const board = changed(keys, "TASK_BOARD_ID") && before.TASK_BOARD_ID?.trim() ? ", but a tick by hand on the old board is no longer noticed" : "";
      lines.push(`${them} when the form arrives${board}.`);
    }
  }
  if (changed(keys, "CT_PUBLISHER_ID", "CT_PUBLISHER_NAME")) {
    const n = c?.needsForm ?? 0;
    const those = n === 1 ? ", including those for the 1 Shift in progress" : n > 1 ? `, including those for the ${n} Shifts in progress` : "";
    lines.push(`Messages from now on come from "${after.CT_PUBLISHER_NAME ?? ""}"${those}.`);
  }
  if (changed(keys, "ALERTS_CHANNEL_ID")) {
    const open = c?.alertsOpen ?? 0;
    if (open > 0) lines.push(`${open === 1 ? "1 problem is" : `${open} problems are`} being reported now. Updates on ${open === 1 ? "it" : "them"} go to the new chat.`);
    else lines.push("Problems from now on are posted in the new chat.");
  }
  if (changed(keys, "INTEGRATOR_RELAY_URL", "INTEGRATOR_CLIENT_SLUG", "INTEGRATOR_RELAY_SECRET")) {
    const was = !!before.INTEGRATOR_RELAY_URL?.trim();
    const now = !!after.INTEGRATOR_RELAY_URL?.trim();
    if (!now) lines.push("Problems are no longer sent to your integrator, and the daily \"still running\" check stops.");
    else if (!was) lines.push("Problems are also sent to your integrator from now on, plus a daily \"still running\" check.");
    else lines.push("Problems and the daily check go to your integrator with the new details.");
  }
  return lines;
}
