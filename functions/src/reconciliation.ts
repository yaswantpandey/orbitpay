/**
 * Daily Automated Reconciliation Job (Task E.3).
 * Reconciles OrbitPay Ledger with Stripe Balance Transactions.
 * Detects discrepancies, drift, and missing settlements.
 */
import { getFirestore, FieldValue, Timestamp, Firestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import Stripe from "stripe";
import { parse, requireAdmin, audit, IS_EMULATOR, CALLABLE_OPTIONS, dayKey } from "./middleware";
import { STRIPE_SECRET_KEY } from "./topup";

export interface StripeBalanceTx {
  id: string;
  amount: number;
  fee: number;
  net: number;
  type: string;
  source?: string | null;
  created: number;
}

export interface StripeClientLike {
  balanceTransactions: {
    list: (params: { created?: { gte?: number; lte?: number }; limit?: number }) => Promise<{
      data: StripeBalanceTx[];
      has_more?: boolean;
    }>;
  };
}

interface TopupDocData {
  id: string;
  amountCents: number;
  stripePaymentIntentId?: string;
  status: string;
  completedAt?: Timestamp;
}

interface PayoutDocData {
  id: string;
  amountCents: number;
  stripeTransferId?: string;
  status: string;
  paidAt?: Timestamp;
}

export interface Discrepancy {
  type: "missing_in_firestore" | "missing_in_stripe" | "amount_mismatch";
  id: string;
  stripeAmountCents?: number;
  firestoreAmountCents?: number;
  details: string;
}

export interface ReconciliationReport {
  id: string;
  status: "balanced" | "drift_detected";
  driftCents: number;
  totalStripeCents: number;
  totalLedgerCents: number;
  reconciledCount: number;
  discrepancies: Discrepancy[];
  windowStart: Timestamp;
  windowEnd: Timestamp;
  createdAt: Timestamp;
}

/**
 * Pure 3-way reconciliation engine comparing Firestore ledger with Stripe balance transactions.
 */
export async function reconcileLedgerWithStripe(
  db: Firestore,
  stripe: StripeClientLike,
  options?: { windowStart?: Date; windowEnd?: Date }
): Promise<ReconciliationReport> {
  const end = options?.windowEnd ?? new Date();
  const start = options?.windowStart ?? new Date(end.getTime() - 24 * 3600_000);

  const startSec = Math.floor(start.getTime() / 1000);
  const endSec = Math.floor(end.getTime() / 1000);

  // 1. Fetch Stripe Balance Transactions in window
  const stripeTxList = await stripe.balanceTransactions.list({
    created: { gte: startSec, lte: endSec },
    limit: 100,
  });
  const stripeTxs = stripeTxList.data ?? [];

  // 2. Fetch Firestore completed Topups and Payouts in window
  const startTs = Timestamp.fromDate(start);
  const endTs = Timestamp.fromDate(end);

  const [topupsSnap, payoutsSnap] = await Promise.all([
    db.collection("topups")
      .where("status", "==", "completed")
      .where("completedAt", ">=", startTs)
      .where("completedAt", "<=", endTs)
      .get(),
    db.collection("payouts")
      .where("status", "==", "paid")
      .where("paidAt", ">=", startTs)
      .where("paidAt", "<=", endTs)
      .get(),
  ]);

  const topups = topupsSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as TopupDocData);
  const payouts = payoutsSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as PayoutDocData);

  const discrepancies: Discrepancy[] = [];
  let totalStripeCents = 0;
  let totalLedgerCents = 0;
  let reconciledCount = 0;

  // Track matched Stripe IDs
  const matchedStripeTxIds = new Set<string>();

  // Verify each Topup in Firestore matches a Stripe transaction
  for (const t of topups) {
    totalLedgerCents += (t.amountCents as number);
    const matched = stripeTxs.find(
      (st) => (t.stripePaymentIntentId && st.source === t.stripePaymentIntentId) || st.id === t.stripePaymentIntentId
    );

    if (!matched) {
      discrepancies.push({
        type: "missing_in_stripe",
        id: t.id,
        firestoreAmountCents: t.amountCents as number,
        details: `Topup ${t.id} completed in Firestore but missing corresponding Stripe balance transaction`,
      });
    } else {
      matchedStripeTxIds.add(matched.id);
      if (matched.amount !== t.amountCents) {
        discrepancies.push({
          type: "amount_mismatch",
          id: t.id,
          stripeAmountCents: matched.amount,
          firestoreAmountCents: t.amountCents as number,
          details: `Topup ${t.id} amount (${t.amountCents}) does not match Stripe transaction ${matched.id} (${matched.amount})`,
        });
      } else {
        reconciledCount++;
      }
    }
  }

  // Verify each Payout in Firestore matches a Stripe transfer
  for (const p of payouts) {
    totalLedgerCents -= (p.amountCents as number);
    const matched = stripeTxs.find(
      (st) => (p.stripeTransferId && st.source === p.stripeTransferId) || st.id === p.stripeTransferId
    );

    if (!matched) {
      discrepancies.push({
        type: "missing_in_stripe",
        id: p.id,
        firestoreAmountCents: p.amountCents as number,
        details: `Payout ${p.id} marked paid in Firestore but missing corresponding Stripe transfer`,
      });
    } else {
      matchedStripeTxIds.add(matched.id);
      if (Math.abs(matched.amount) !== p.amountCents) {
        discrepancies.push({
          type: "amount_mismatch",
          id: p.id,
          stripeAmountCents: Math.abs(matched.amount),
          firestoreAmountCents: p.amountCents as number,
          details: `Payout ${p.id} amount (${p.amountCents}) does not match Stripe transfer ${matched.id} (${Math.abs(matched.amount)})`,
        });
      } else {
        reconciledCount++;
      }
    }
  }

  // Check for any unmatched Stripe transactions (money moved on Stripe but not in OrbitPay)
  for (const st of stripeTxs) {
    totalStripeCents += st.amount;
    if (!matchedStripeTxIds.has(st.id)) {
      discrepancies.push({
        type: "missing_in_firestore",
        id: st.id,
        stripeAmountCents: st.amount,
        details: `Stripe balance transaction ${st.id} (${st.type}) has no matching record in OrbitPay ledger`,
      });
    }
  }

  const driftCents = totalStripeCents - totalLedgerCents;
  const status = driftCents === 0 && discrepancies.length === 0 ? "balanced" : "drift_detected";

  const reportId = `recon_${dayKey(start)}_${Date.now()}`;
  const report: ReconciliationReport = {
    id: reportId,
    status,
    driftCents,
    totalStripeCents,
    totalLedgerCents,
    reconciledCount,
    discrepancies,
    windowStart: startTs,
    windowEnd: endTs,
    createdAt: Timestamp.now(),
  };

  // Persist report in Firestore
  await db.doc(`reconciliations/${reportId}`).set(report);

  if (status === "drift_detected") {
    logger.error("RECONCILIATION_DRIFT_ALERT", {
      reportId,
      driftCents,
      discrepancyCount: discrepancies.length,
      discrepancies,
    });
    // Persist each discrepancy for ops review
    const batch = db.batch();
    for (const d of discrepancies) {
      const discRef = db.doc(`reconciliationDiscrepancies/${reportId}_${d.id}`);
      batch.set(discRef, { ...d, reportId, resolved: false, createdAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
  } else {
    logger.info("Reconciliation balanced successfully", { reportId, reconciledCount });
  }

  return report;
}

/** Scheduled nightly reconciliation job at 02:00 UTC */
export const reconciliationDailyTick = onSchedule(
  { ...CALLABLE_OPTIONS, schedule: "0 2 * * *", secrets: [STRIPE_SECRET_KEY] },
  async () => {
    const db = getFirestore();
    const stripe = new Stripe(STRIPE_SECRET_KEY.value()) as unknown as StripeClientLike;
    await reconcileLedgerWithStripe(db, stripe);
  }
);

/** Admin-triggered manual reconciliation */
export const runReconciliation = onCall(
  { ...CALLABLE_OPTIONS, secrets: [STRIPE_SECRET_KEY] },
  async (req) => {
    const adminUid = requireAdmin(req);
    const db = getFirestore();
    const stripe = IS_EMULATOR
      ? ({ balanceTransactions: { list: async () => ({ data: [] }) } } as unknown as StripeClientLike)
      : (new Stripe(STRIPE_SECRET_KEY.value()) as unknown as StripeClientLike);

    const report = await reconcileLedgerWithStripe(db, stripe);
    await audit(adminUid, "admin.reconciliation_run", { reportId: report.id, status: report.status, driftCents: report.driftCents });
    return report;
  }
);
