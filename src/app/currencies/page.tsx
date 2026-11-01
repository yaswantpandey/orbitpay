"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { v4 as uuid } from "uuid";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KycBanner } from "@/components/kyc-banner";
import { useAuth } from "@/components/auth-provider";
import { db, functions } from "@/lib/firebase";
import { CURRENCIES } from "@/lib/format";
import { useBalances, useWallet } from "@/lib/hooks";
import type { FxRates } from "@/types";

const SPREAD = 0.005; // must match functions/src/currencies.ts
const decimals = (c: string) => (c === "JPY" ? 0 : 2);
const fmt = (minor: number, cur: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(minor / 10 ** decimals(cur));

/** Parse a user amount into minor units without floats ("12.34" → 1234; JPY "500" → 500). */
function toMinor(input: string, cur: string): number | null {
  const d = decimals(cur);
  const m = input.trim().match(d === 0 ? /^(\d{1,9})$/ : /^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 10 ** d + (d ? parseInt((m[2] ?? "").padEnd(2, "0"), 10) : 0);
}

export default function CurrenciesPage() {
  const { user } = useAuth();
  const wallet = useWallet();
  const balances = useBalances();
  const [fx, setFx] = useState<FxRates | null>(null);
  const [from, setFrom] = useState("USD");
  const [to, setTo] = useState("EUR");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<{ amountMinor: number; toMinor: number; rate: number; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useSyncExternalStore(
    () => () => {},
    () => Date.now(),
    () => 0
  );
  const stale = fx && now ? now - fx.fetchedAt.toMillis() > 24 * 3600_000 : false;

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "fxRates", "latest"), (s) => setFx(s.exists() ? (s.data() as FxRates) : null));
  }, [user]);

  const held = useMemo(() => {
    const m: Record<string, number> = { USD: wallet?.balanceCents ?? 0 };
    balances.forEach((b) => { m[b.currency] = b.balanceMinor; });
    return m;
  }, [wallet, balances]);

  const rateOf = (c: string) => (c === "USD" ? 1 : fx?.rates[c]);
  const effRate = rateOf(from) && rateOf(to) ? (rateOf(to)! / rateOf(from)!) * (1 - SPREAD) : null;

  function review(e: React.FormEvent) {
    e.preventDefault();
    if (from === to) return toast.error("Pick two different currencies");
    if (!effRate || stale) return toast.error("Exchange rates are unavailable right now");
    const amountMinor = toMinor(amount, from);
    if (!amountMinor) return toast.error(`Enter a valid ${from} amount`);
    if (amountMinor > (held[from] ?? 0)) return toast.error("Insufficient funds");
    const toMinorAmt = Math.floor((amountMinor / 10 ** decimals(from)) * effRate * 10 ** decimals(to) + 1e-9);
    if (toMinorAmt <= 0) return toast.error("Amount too small to convert");
    setQuote({ amountMinor, toMinor: toMinorAmt, rate: effRate, key: uuid() });
  }

  async function confirm() {
    if (!quote) return;
    setBusy(true);
    try {
      const { data } = await httpsCallable<unknown, { toMinor: number }>(functions, "convert")({
        from, to, amountMinor: quote.amountMinor, idempotencyKey: quote.key, quotedRate: quote.rate,
      });
      toast.success(`Converted to ${fmt(data.toMinor, to)}`);
      setQuote(null);
      setAmount("");
    } catch (err) {
      toast.error((err as Error).message);
      setQuote(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <KycBanner />
      <Card>
        <CardHeader>
          <CardTitle>Your currencies</CardTitle>
          <CardDescription>Sending, requests and withdrawals use your USD balance.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 sm:grid-cols-3">
            {CURRENCIES.filter((c) => c === "USD" || held[c] !== undefined).map((c) => (
              <li key={c} className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">{c}</p>
                <p className="text-lg font-semibold tabular-nums">{fmt(held[c] ?? 0, c)}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{quote ? "Confirm conversion" : "Convert"}</CardTitle>
          <CardDescription>
            {fx ? `Rates updated ${fx.fetchedAt.toDate().toLocaleString()}` : "Loading rates…"} · {(SPREAD * 100).toFixed(1)}% exchange fee included
            {stale && <span className="text-red-600"> · rates are out of date</span>}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {quote ? (
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-3 text-lg font-semibold tabular-nums">
                {fmt(quote.amountMinor, from)} <ArrowRight className="size-5" /> {fmt(quote.toMinor, to)}
              </div>
              <p className="text-center text-sm text-muted-foreground">1 {from} = {quote.rate.toFixed(6)} {to} (after fee)</p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setQuote(null)} disabled={busy}>Back</Button>
                <Button className="flex-1" onClick={confirm} disabled={busy}>{busy ? "Converting…" : "Convert"}</Button>
              </div>
            </div>
          ) : (
            <form onSubmit={review} className="grid gap-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
              <div className="space-y-1">
                <Label htmlFor="from">From</Label>
                <select id="from" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="to">To</Label>
                <select id="to" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="amt">Amount ({from})</Label>
                <Input id="amt" inputMode="decimal" placeholder={decimals(from) ? "0.00" : "0"} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <Button type="submit">Get quote</Button>
              {effRate && from !== to && (
                <p className="text-xs text-muted-foreground sm:col-span-4">1 {from} ≈ {effRate.toFixed(6)} {to} after fee</p>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
