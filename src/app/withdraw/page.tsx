"use client";

import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { v4 as uuid } from "uuid";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KycBanner } from "@/components/kyc-banner";
import { useAuth } from "@/components/auth-provider";
import { functions } from "@/lib/firebase";
import { formatCents } from "@/lib/format";
import { usePayouts, useWallet } from "@/lib/hooks";
import { dollarsToCents } from "@/lib/schemas";

const DEV = process.env.NEXT_PUBLIC_USE_EMULATORS === "true";

export default function WithdrawPage() {
  const { profile } = useAuth();
  const wallet = useWallet();
  const payouts = usePayouts();
  const [amount, setAmount] = useState("");
  const [draft, setDraft] = useState<{ amountCents: number; idempotencyKey: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("linked")) toast.success("Bank account linked with Stripe");
  }, []);

  async function linkBank() {
    setBusy(true);
    try {
      const { data } = await httpsCallable<unknown, { url: string | null }>(functions, "createPayoutAccountLink")({});
      if (data.url) window.location.assign(data.url);
      else toast.success("Test bank account linked (dev mode)");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function review(e: React.FormEvent) {
    e.preventDefault();
    const amountCents = dollarsToCents(amount);
    if (amountCents === null || amountCents < 100) return toast.error("Minimum withdrawal is $1.00");
    if (wallet && amountCents > wallet.balanceCents) return toast.error("Insufficient funds");
    setDraft({ amountCents, idempotencyKey: uuid() });
  }

  async function confirm() {
    if (!draft) return;
    setBusy(true);
    try {
      const { data } = await httpsCallable<unknown, { status: string }>(functions, "requestPayout")(draft);
      toast.success(data.status === "paid" ? "Withdrawal sent to your bank" : "Withdrawal requested");
      setDraft(null);
      setAmount("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function devSettle(payoutId: string, outcome: "paid" | "failed") {
    try {
      await httpsCallable(functions, "devSettlePayout")({ payoutId, outcome });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <KycBanner />
      <Card>
        <CardHeader>
          <CardTitle>{draft ? "Confirm withdrawal" : "Withdraw to bank"}</CardTitle>
          <CardDescription>Available: {wallet ? formatCents(wallet.balanceCents) : "—"}</CardDescription>
        </CardHeader>
        <CardContent>
          {!profile?.payoutAccountId ? (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">Link a bank account through Stripe to withdraw. OrbitPay never sees your account number.</p>
              <Button className="w-full" onClick={linkBank} disabled={busy}>{busy ? "Opening…" : "Link bank account"}</Button>
            </div>
          ) : draft ? (
            <div className="space-y-4">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">Amount</dt>
                  <dd className="text-lg font-semibold">{formatCents(draft.amountCents)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">To</dt><dd>Linked bank account</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Fee</dt><dd>$0.00</dd></div>
              </dl>
              <p className="text-xs text-muted-foreground">Funds leave your wallet now. If the bank rejects the payout, they are returned automatically.</p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setDraft(null)} disabled={busy}>Back</Button>
                <Button className="flex-1" onClick={confirm} disabled={busy}>{busy ? "Withdrawing…" : "Withdraw"}</Button>
              </div>
            </div>
          ) : (
            <form onSubmit={review} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="amount">Amount (USD)</Label>
                <Input id="amount" inputMode="decimal" placeholder="0.00" required value={amount}
                  onChange={(e) => setAmount(e.target.value)} />
              </div>
              <Button type="submit" className="w-full">Review</Button>
              {!DEV && !profile.payoutsEnabled && (
                <button type="button" className="w-full text-xs text-muted-foreground hover:underline" onClick={linkBank}>
                  Finish bank setup with Stripe
                </button>
              )}
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Withdrawals</CardTitle></CardHeader>
        <CardContent>
          {payouts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No withdrawals yet.</p>
          ) : (
            <ul className="divide-y">
              {payouts.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums">{formatCents(p.amountCents)}</span>
                      <Badge variant={p.status === "failed" ? "destructive" : p.status === "paid" ? "secondary" : "outline"}>
                        {p.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {p.createdAt?.toDate().toLocaleString() ?? "…"}{p.failureReason ? ` — ${p.failureReason} (refunded)` : ""}
                    </p>
                  </div>
                  {DEV && p.status === "pending" && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => devSettle(p.id, "paid")}>Mark paid</Button>
                      <Button size="sm" variant="outline" onClick={() => devSettle(p.id, "failed")}>Fail</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
