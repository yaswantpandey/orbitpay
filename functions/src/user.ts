import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentDeleted } from "firebase-functions/v2/firestore";
import { requireAuth, audit, IS_EMULATOR } from "./middleware";

/** Creates the user profile and empty wallet on first sign-in. Idempotent. */
export const bootstrapUser = onCall(async (req) => {
  const uid = requireAuth(req);
  const db = getFirestore();
  const token = req.auth!.token;
  const mfaEnabled =
    (token.firebase as { sign_in_second_factor?: string }).sign_in_second_factor === "totp";

  await db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const walletRef = db.doc(`wallets/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      tx.set(userRef, {
        email: (token.email ?? "").toLowerCase(),
        displayName: token.name ?? "",
        kycStatus: "none",
        emailVerified: token.email_verified === true,
        mfaEnabled,
        displayCurrency: "USD",
        tier: 0,
        contactCount: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(walletRef, {
        balanceCents: 0,
        currency: "USD",
        version: 0,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      const updates: Record<string, unknown> = {};
      if (mfaEnabled && !userSnap.data()!.mfaEnabled) updates.mfaEnabled = true;
      if (token.email_verified === true && !userSnap.data()!.emailVerified) updates.emailVerified = true;
      if (Object.keys(updates).length > 0) tx.update(userRef, updates);
    }
  });
  return { ok: true };
});

/**
 * DEV ONLY: marks the caller as KYC-verified (tier 1) in the emulator.
 * Real KYC provider integration is Phase 5.
 */
export const devVerifyKyc = onCall(async (req) => {
  if (!IS_EMULATOR) throw new HttpsError("permission-denied", "Not available");
  const uid = requireAuth(req);
  await getFirestore().doc(`users/${uid}`).update({ kycStatus: "verified", tier: 1 });
  await audit(uid, "kyc.dev_verified", {});
  return { ok: true };
});

export const onContactCreated = onDocumentCreated("users/{uid}/contacts/{contactId}", async (e) => {
  const uid = e.params.uid;
  await getFirestore().doc(`users/${uid}`).set({
    contactCount: FieldValue.increment(1),
  }, { merge: true });
});

export const onContactDeleted = onDocumentDeleted("users/{uid}/contacts/{contactId}", async (e) => {
  const uid = e.params.uid;
  await getFirestore().doc(`users/${uid}`).set({
    contactCount: FieldValue.increment(-1),
  }, { merge: true });
});
