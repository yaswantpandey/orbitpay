/**
 * Reconciliation Job Unit & Integration Tests (Task E.3).
 * Tests 3-way matching between Firestore and Stripe,
 * verifying drift detection on injected mismatches.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore, Timestamp } from "firebase-admin/firestore";
import { reconcileLedgerWithStripe, StripeClientLike, StripeBalanceTx } from "./reconciliation";

let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run with the Firestore emulator");
  if (getApps().length === 0) initializeApp({ projectId: "demo-fastpay" });
  db = getFirestore();
});

async function clearReconData() {
  for (const c of ["topups", "payouts", "reconciliations", "reconciliationDiscrepancies"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

describe("Reconciliation Job & Drift Detection (Task E.3)", () => {
  beforeEach(async () => {
    await clearReconData();
  });

  it("reports balanced when Firestore ledger exactly matches Stripe balance transactions", async () => {
    const now = new Date();
    const nowTs = Timestamp.fromDate(now);

    // Seed Firestore topup and payout
    await db.doc("topups/topup_recon_1").set({
      uid: "user_recon_1",
      amountCents: 5_000,
      status: "completed",
      stripePaymentIntentId: "pi_match_1",
      completedAt: nowTs,
    });

    await db.doc("payouts/payout_recon_1").set({
      uid: "user_recon_1",
      amountCents: 2_000,
      status: "paid",
      stripeTransferId: "tr_match_1",
      paidAt: nowTs,
    });

    // Mock matching Stripe balance transactions
    const mockStripe: StripeClientLike = {
      balanceTransactions: {
        list: async () => ({
          data: [
            {
              id: "txn_stripe_topup_1",
              amount: 5_000,
              fee: 175,
              net: 4_825,
              type: "charge",
              source: "pi_match_1",
              created: Math.floor(now.getTime() / 1000),
            },
            {
              id: "txn_stripe_payout_1",
              amount: -2_000,
              fee: 0,
              net: -2_000,
              type: "transfer",
              source: "tr_match_1",
              created: Math.floor(now.getTime() / 1000),
            },
          ],
        }),
      },
    };

    const report = await reconcileLedgerWithStripe(db, mockStripe, {
      windowStart: new Date(now.getTime() - 3600_000),
      windowEnd: new Date(now.getTime() + 3600_000),
    });

    expect(report.status).toBe("balanced");
    expect(report.driftCents).toBe(0);
    expect(report.discrepancies).toHaveLength(0);
    expect(report.reconciledCount).toBe(2);

    // Verify report was persisted in Firestore
    const savedReport = (await db.doc(`reconciliations/${report.id}`).get()).data();
    expect(savedReport).toBeDefined();
    expect(savedReport?.status).toBe("balanced");
  });

  it("detects drift and flags discrepancies on injected mismatches", async () => {
    const now = new Date();
    const nowTs = Timestamp.fromDate(now);

    // Case A: Amount mismatch (Firestore has 10,000 cents, Stripe settled 8,000 cents)
    await db.doc("topups/topup_mismatch").set({
      uid: "user_recon_2",
      amountCents: 10_000,
      status: "completed",
      stripePaymentIntentId: "pi_mismatch_1",
      completedAt: nowTs,
    });

    // Case B: Missing in Stripe (Firestore payout of 4,000 cents not found on Stripe)
    await db.doc("payouts/payout_missing_in_stripe").set({
      uid: "user_recon_2",
      amountCents: 4_000,
      status: "paid",
      stripeTransferId: "tr_ghost_1",
      paidAt: nowTs,
    });

    // Case C: Missing in Firestore (Stripe has an unexpected charge of 3,000 cents)
    const mockStripe: StripeClientLike = {
      balanceTransactions: {
        list: async () => ({
          data: [
            {
              id: "txn_stripe_mismatch",
              amount: 8_000, // Mismatch: 8,000 vs 10,000
              fee: 250,
              net: 7_750,
              type: "charge",
              source: "pi_mismatch_1",
              created: Math.floor(now.getTime() / 1000),
            },
            {
              id: "txn_stripe_extra_unmapped",
              amount: 3_000, // Unmapped in Firestore
              fee: 90,
              net: 2_910,
              type: "charge",
              source: "pi_unmapped_external",
              created: Math.floor(now.getTime() / 1000),
            },
          ],
        }),
      },
    };

    const report = await reconcileLedgerWithStripe(db, mockStripe, {
      windowStart: new Date(now.getTime() - 3600_000),
      windowEnd: new Date(now.getTime() + 3600_000),
    });

    expect(report.status).toBe("drift_detected");
    expect(report.discrepancies.length).toBeGreaterThanOrEqual(3);

    // Verify individual discrepancy types
    const amountMismatch = report.discrepancies.find((d) => d.type === "amount_mismatch");
    expect(amountMismatch).toBeDefined();
    expect(amountMismatch?.id).toBe("topup_mismatch");
    expect(amountMismatch?.firestoreAmountCents).toBe(10_000);
    expect(amountMismatch?.stripeAmountCents).toBe(8_000);

    const missingInStripe = report.discrepancies.find((d) => d.type === "missing_in_stripe");
    expect(missingInStripe).toBeDefined();
    expect(missingInStripe?.id).toBe("payout_missing_in_stripe");

    const missingInFirestore = report.discrepancies.find((d) => d.type === "missing_in_firestore");
    expect(missingInFirestore).toBeDefined();
    expect(missingInFirestore?.id).toBe("txn_stripe_extra_unmapped");

    // Verify discrepancy records were persisted for ops alerting
    const discSnap = await db.collection("reconciliationDiscrepancies").get();
    expect(discSnap.empty).toBe(false);
  });
});

