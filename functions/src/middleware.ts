import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { ZodSchema } from "zod";

export const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";
export const CALLABLE_OPTIONS = {
  region: "us-central1" as const,
  maxInstances: 100,
  enforceAppCheck: !IS_EMULATOR,
};
// DISABLE_MFA=true temporarily skips the TOTP requirement in emulator only.
const DISABLE_MFA = IS_EMULATOR && process.env.DISABLE_MFA === "true";

// Limits in cents by KYC tier.
export const TIER_LIMITS: Record<number, { perTransaction: number; perDay: number }> = {
  0: { perTransaction: 0, perDay: 0 },
  1: { perTransaction: 100_000, perDay: 250_000 }, // $1k / $2.5k
  2: { perTransaction: 1_000_000, perDay: 2_500_000 }, // $10k / $25k
};

export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpsError("invalid-argument", r.error.issues[0]?.message ?? "Invalid input");
  return r.data;
}

export function requireAuth(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required");
  return req.auth.uid;
}

/** Auth + TOTP 2FA + verified KYC. Required for any money movement. */
export async function requireMoneyMover(req: CallableRequest) {
  const uid = requireAuth(req);
  const secondFactor = (req.auth!.token.firebase as { sign_in_second_factor?: string })
    .sign_in_second_factor;
  if (!IS_EMULATOR && !DISABLE_MFA && secondFactor !== "totp") {
    throw new HttpsError("permission-denied", "Two-factor authentication required");
  }
  const snap = await getFirestore().doc(`users/${uid}`).get();
  const user = snap.data();
  if (!user) throw new HttpsError("failed-precondition", "Profile not found");
  if (user.kycStatus !== "verified") {
    throw new HttpsError("failed-precondition", "Identity verification (KYC) required");
  }
  if (user.frozen) throw new HttpsError("permission-denied", "This account is frozen. Contact support.");
  return { uid, user, limits: TIER_LIMITS[user.tier ?? 0] ?? TIER_LIMITS[0] };
}

/** Admin is a custom auth claim set by functions/scripts/make-admin.mjs, never a Firestore field. */
export function requireAdmin(req: CallableRequest): string {
  const uid = requireAuth(req);
  if (req.auth!.token.admin !== true) throw new HttpsError("permission-denied", "Admins only");
  return uid;
}

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/** Monthly in/out totals for insights. Write-only increments, so no transaction read needed. */
export function bumpStats(
  tx: FirebaseFirestore.Transaction, uid: string, field: "inCents" | "outCents", cents: number
) {
  const m = monthKey();
  tx.set(getFirestore().doc(`stats/${uid}_${m}`), { uid, month: m, [field]: FieldValue.increment(cents) }, { merge: true });
}

export async function audit(actorUid: string, action: string, metadata: Record<string, unknown>, ip = "") {
  await getFirestore().collection("auditLogs").add({
    actorUid,
    action,
    metadata,
    ip,
    createdAt: FieldValue.serverTimestamp(),
  });
}

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
