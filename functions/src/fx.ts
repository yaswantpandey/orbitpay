import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { requireAuth, IS_EMULATOR, CALLABLE_OPTIONS } from "./middleware";

// Keep in sync with CURRENCIES in src/lib/format.ts. Rates are display-only; the ledger is USD.
const CURRENCIES = ["EUR", "GBP", "INR", "JPY", "CAD", "AUD"];
const SOURCE = "https://open.er-api.com/v6/latest/USD";

export async function refreshRates() {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`FX source HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; base_code?: string; rates?: Record<string, unknown> };
  if (body.result !== "success" || body.base_code !== "USD" || !body.rates) throw new Error("Unexpected FX payload");

  const rates: Record<string, number> = {};
  for (const c of CURRENCIES) {
    const r = body.rates[c];
    // Reject garbage so a bad feed never shows absurd balances; keep the last good doc instead.
    if (typeof r !== "number" || !Number.isFinite(r) || r <= 0 || r > 100_000) throw new Error(`Bad rate for ${c}`);
    rates[c] = r;
  }
  await getFirestore().doc("fxRates/latest").set({ base: "USD", rates, source: SOURCE, fetchedAt: Timestamp.now() });
  return rates;
}

export const fetchFxRates = onSchedule("every 60 minutes", async () => {
  try {
    logger.info("fxRates updated", await refreshRates());
  } catch (err) {
    logger.error("fxRates refresh failed; keeping previous rates", err);
  }
});

/** DEV ONLY: scheduled functions don't fire in the emulator, so refresh on demand. */
export const devRefreshFx = onCall(CALLABLE_OPTIONS, async (req) => {
  if (!IS_EMULATOR) throw new HttpsError("permission-denied", "Not available");
  requireAuth(req);
  return { rates: await refreshRates() };
});
