import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { createScheduleSchema, scheduleActionSchema } from "./schemas";
import { parse, requireAuth, requireMoneyMover, audit, TIER_LIMITS, IS_EMULATOR, CALLABLE_OPTIONS } from "./middleware";
import { executeTransfer } from "./transfer";

const MAX_FAILURES = 3;

/** Next run after `from`, keeping the original day of month (clamped to the month's length). */
export function nextRun(from: Date, frequency: "weekly" | "monthly", anchorDay: number): Date {
  if (frequency === "weekly") return new Date(from.getTime() + 7 * 864e5);
  const y = from.getUTCFullYear(), m = from.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchorDay, lastDay), from.getUTCHours(), from.getUTCMinutes()));
}

export const createSchedule = onCall(CALLABLE_OPTIONS, async (req) => {
  const input = parse(createScheduleSchema, req.data);
  const { uid, user, limits } = await requireMoneyMover(req);
  const db = getFirestore();
  const toEmail = input.toEmail.toLowerCase();
  if (toEmail === user.email) throw new HttpsError("invalid-argument", "Cannot pay yourself");
  if (input.amountCents > limits.perTransaction) {
    throw new HttpsError("resource-exhausted", "Amount exceeds per-transaction limit");
  }
  const start = new Date(`${input.startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || start.getTime() < Date.now() - 864e5) {
    throw new HttpsError("invalid-argument", "Start date must be today or later");
  }
  const recipients = await db.collection("users").where("email", "==", toEmail).limit(1).get();
  if (recipients.empty) throw new HttpsError("not-found", "Recipient not found");

  const ref = db.collection("schedules").doc();
  await ref.set({
    ownerUid: uid, ownerEmail: user.email, toUid: recipients.docs[0].id, toEmail,
    amountCents: input.amountCents, note: input.note ?? "", frequency: input.frequency,
    anchorDay: start.getUTCDate(), nextRunAt: Timestamp.fromDate(start),
    runCount: 0, failures: 0, status: "active", createdAt: FieldValue.serverTimestamp(),
  });
  await audit(uid, "schedule.created", { scheduleId: ref.id, amountCents: input.amountCents, frequency: input.frequency });
  return { scheduleId: ref.id };
});

export const scheduleAction = onCall(CALLABLE_OPTIONS, async (req) => {
  const { scheduleId, action } = parse(scheduleActionSchema, req.data);
  const uid = requireAuth(req);
  const db = getFirestore();
  const ref = db.doc(`schedules/${scheduleId}`);
  const status = await db.runTransaction(async (tx) => {
    const s = (await tx.get(ref)).data();
    if (!s || s.ownerUid !== uid) throw new HttpsError("not-found", "Schedule not found");
    if (s.status === "cancelled") throw new HttpsError("failed-precondition", "Schedule is cancelled");
    if (action === "pause") { tx.update(ref, { status: "paused" }); return "paused"; }
    if (action === "cancel") { tx.update(ref, { status: "cancelled" }); return "cancelled"; }
    // Resuming skips any runs missed while paused instead of paying them all at once.
    let next = (s.nextRunAt as Timestamp).toDate();
    while (next.getTime() < Date.now()) next = nextRun(next, s.frequency, s.anchorDay);
    tx.update(ref, { status: "active", failures: 0, lastError: FieldValue.delete(), nextRunAt: Timestamp.fromDate(next) });
    return "active";
  });
  await audit(uid, `schedule.${action}`, { scheduleId });
  return { status };
});

/** Execute one due run. The run counter advances inside the transfer transaction, so it's exactly-once. */
export async function runSchedule(scheduleId: string): Promise<"paid" | "skipped" | "failed"> {
  const db = getFirestore();
  const ref = db.doc(`schedules/${scheduleId}`);
  const s = (await ref.get()).data();
  if (!s || s.status !== "active" || (s.nextRunAt as Timestamp).toMillis() > Date.now()) return "skipped";
  const n = s.runCount as number;
  try {
    const owner = (await db.doc(`users/${s.ownerUid}`).get()).data();
    if (!owner || owner.kycStatus !== "verified") throw new Error("Identity verification required");
    if (owner.frozen) throw new Error("Account is frozen");
    const limits = TIER_LIMITS[owner.tier ?? 0] ?? TIER_LIMITS[0];
    if (s.amountCents > limits.perTransaction) throw new Error("Amount exceeds per-transaction limit");

    // Advance past "now" so downtime results in one catch-up payment, not one per missed period.
    let next = nextRun((s.nextRunAt as Timestamp).toDate(), s.frequency, s.anchorDay);
    while (next.getTime() <= Date.now()) next = nextRun(next, s.frequency, s.anchorDay);
    const r = await executeTransfer(
      db,
      {
        fromUid: s.ownerUid, toUid: s.toUid, fromEmail: s.ownerEmail, toEmail: s.toEmail,
        amountCents: s.amountCents, note: s.note || "Recurring payment",
        idempotencyKey: `sched_${scheduleId}_${n}`, perDayLimit: limits.perDay,
      },
      {
        ref,
        check: (cur) => {
          if (cur?.status !== "active" || cur.runCount !== n) throw new HttpsError("aborted", "Run already handled");
        },
        update: { runCount: n + 1, failures: 0, nextRunAt: Timestamp.fromDate(next), lastError: FieldValue.delete() },
      }
    );
    return r.replayed ? "skipped" : "paid";
  } catch (err) {
    if (err instanceof HttpsError && err.code === "aborted") return "skipped";
    const failures = (s.failures ?? 0) + 1;
    await ref.update({
      failures, lastError: (err as Error).message, lastAttemptAt: FieldValue.serverTimestamp(),
      ...(failures >= MAX_FAILURES ? { status: "paused" } : {}),
    });
    await db.doc(`notifications/${scheduleId}_fail_${n}_${failures}`).set({
      uid: s.ownerUid, kind: "schedule_failed", amountCents: s.amountCents, fromEmail: s.toEmail,
      note: failures >= MAX_FAILURES ? `Paused after ${failures} failures: ${(err as Error).message}` : (err as Error).message,
      read: false, createdAt: FieldValue.serverTimestamp(),
    });
    return "failed";
  }
}

export async function runDueSchedules() {
  const due = await getFirestore().collection("schedules")
    .where("status", "==", "active").where("nextRunAt", "<=", Timestamp.now()).limit(200).get();
  const results = { paid: 0, skipped: 0, failed: 0 };
  for (const d of due.docs) results[await runSchedule(d.id)]++;
  return results;
}

export const runSchedulesTick = onSchedule("every 15 minutes", async () => {
  logger.info("runSchedulesTick", await runDueSchedules());
});

/** DEV ONLY: scheduled functions don't fire in the emulator. */
export const devRunSchedules = onCall(CALLABLE_OPTIONS, async (req) => {
  if (!IS_EMULATOR) throw new HttpsError("permission-denied", "Not available");
  requireAuth(req);
  return runDueSchedules();
});
