import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import Stripe from "stripe";
import { devKycSchema, adminSetTierSchema } from "./schemas";
import { parse, requireAuth, requireAdmin, audit, IS_EMULATOR } from "./middleware";
import { STRIPE_SECRET_KEY } from "./topup";

const DEV_KYC = IS_EMULATOR;
const APP_URL = process.env.APP_URL ?? "http://localhost:3001";

/** Starts a Stripe Identity document + selfie check and returns the hosted verification URL. */
export const startKyc = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (req) => {
  const uid = requireAuth(req);
  const db = getFirestore();
  const user = (await db.doc(`users/${uid}`).get()).data();
  if (!user) throw new HttpsError("failed-precondition", "Profile not found");
  if (user.kycStatus === "verified") return { status: "verified", url: null };
  if (DEV_KYC) {
    const sessionId = `dev_${Date.now()}`;
    await db.doc(`users/${uid}`).update({ kycStatus: "pending", kycSessionId: sessionId });
    return { status: "pending", url: null, dev: true };
  }
  const session = await new Stripe(STRIPE_SECRET_KEY.value()).identity.verificationSessions.create({
    type: "document",
    options: { document: { require_matching_selfie: true, require_live_capture: true } },
    metadata: { uid },
    return_url: `${APP_URL}/settings?kyc=returned`,
  });
  await db.doc(`users/${uid}`).update({ kycStatus: "pending", kycSessionId: session.id, kycError: FieldValue.delete() });
  await audit(uid, "kyc.started", { sessionId: session.id });
  return { status: "pending", url: session.url };
});

/** Applies a verification outcome. Only ever upgrades tier 0 → 1; tier 2 is an admin decision. */
export async function applyKycResult(uid: string, sessionId: string, outcome: "verified" | "rejected", reason = "") {
  const db = getFirestore();
  const ref = db.doc(`users/${uid}`);
  await db.runTransaction(async (tx) => {
    const u = (await tx.get(ref)).data();
    // Ignore stale sessions (user restarted verification) and never downgrade a verified user.
    if (!u || u.kycSessionId !== sessionId || u.kycStatus === "verified") return;
    tx.update(ref, outcome === "verified"
      ? { kycStatus: "verified", tier: Math.max(1, u.tier ?? 0), kycVerifiedAt: FieldValue.serverTimestamp(), kycError: FieldValue.delete() }
      : { kycStatus: "rejected", kycError: reason || "Verification failed" });
    tx.set(db.doc(`notifications/kyc_${sessionId}`), {
      uid, kind: "kyc", amountCents: 0, fromEmail: "OrbitPay",
      note: outcome === "verified" ? "Your identity is verified" : `Verification failed: ${reason || "please try again"}`,
      read: false, createdAt: FieldValue.serverTimestamp(),
    });
  });
  await audit(uid, `kyc.${outcome}`, { sessionId, reason });
}

/** Called from the Stripe webhook for identity.verification_session.* events. */
export async function handleIdentityEvent(event: Stripe.Event) {
  const s = event.data.object as Stripe.Identity.VerificationSession;
  const uid = s.metadata?.uid;
  if (!uid) return;
  if (event.type === "identity.verification_session.verified") {
    await applyKycResult(uid, s.id, "verified");
  } else if (event.type === "identity.verification_session.requires_input" || event.type === "identity.verification_session.canceled") {
    await applyKycResult(uid, s.id, "rejected", s.last_error?.reason ?? s.last_error?.code ?? event.type);
  } else {
    logger.info("Ignoring identity event", event.type);
  }
}

/** DEV ONLY: simulate the Stripe Identity outcome for the caller's pending session. */
export const devCompleteKyc = onCall(async (req) => {
  if (!DEV_KYC) throw new HttpsError("permission-denied", "Not available");
  const uid = requireAuth(req);
  const { outcome } = parse(devKycSchema, req.data);
  const u = (await getFirestore().doc(`users/${uid}`).get()).data();
  if (!u?.kycSessionId) throw new HttpsError("failed-precondition", "Start verification first");
  await applyKycResult(uid, u.kycSessionId, outcome, outcome === "rejected" ? "document_unverified_other" : "");
  return { status: outcome };
});

export const adminSetTier = onCall(async (req) => {
  const adminUid = requireAdmin(req);
  const { uid, tier, reason } = parse(adminSetTierSchema, req.data);
  const ref = getFirestore().doc(`users/${uid}`);
  const u = (await ref.get()).data();
  if (!u) throw new HttpsError("not-found", "User not found");
  if (tier > 0 && u.kycStatus !== "verified") throw new HttpsError("failed-precondition", "User must be KYC-verified first");
  await ref.update({ tier });
  await audit(adminUid, "admin.set_tier", { targetUid: uid, from: u.tier ?? 0, to: tier, reason }, req.rawRequest.ip ?? "");
  return { tier };
});
