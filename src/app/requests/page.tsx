"use client";

import { useState, useSyncExternalStore } from "react";
import { httpsCallable } from "firebase/functions";
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
import { usePaymentRequests } from "@/lib/hooks";
import { createRequestSchema, dollarsToCents } from "@/lib/schemas";
import type { PaymentRequest } from "@/types";

export default function RequestsPage() {
  const { user } = useAuth();
  const requests = usePaymentRequests();
  const [payerEmail, setPayerEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const amountCents = dollarsToCents(amount);
    if (amountCents === null) return toast.error("Enter a valid amount, e.g. 12.50");
    const parsed = createRequestSchema.safeParse({ payerEmail: payerEmail.trim(), amountCents, note });
    if (!parsed.success) return toast.error(parsed.error.issues[0].message);
    setBusy("create");
    try {
      await httpsCallable(functions, "createRequest")(parsed.data);
      toast.success(`Requested ${formatCents(amountCents)} from ${parsed.data.payerEmail}`);
      setPayerEmail(""); setAmount(""); setNote("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function respond(r: PaymentRequest, action: "pay" | "decline") {
    if (action === "pay" && !confirm(`Pay ${formatCents(r.amountCents)} to ${r.requesterEmail}?`)) return;
    setBusy(r.id);
    try {
      await httpsCallable(functions, "respondRequest")({ requestId: r.id, action });
      toast.success(action === "pay" ? "Paid" : "Declined");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const incoming = requests.filter((r) => r.payerUid === user?.uid);
  const outgoing = requests.filter((r) => r.requesterUid === user?.uid);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <KycBanner />
      <Card>
        <CardHeader>
          <CardTitle>Request money</CardTitle>
          <CardDescription>The payer must have an OrbitPay account. Requests expire after 7 days.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="payer">From (email)</Label>
              <Input id="payer" type="email" required value={payerEmail} onChange={(e) => setPayerEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="amount">Amount (USD)</Label>
              <Input id="amount" inputMode="decimal" placeholder="0.00" required value={amount}
                onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="note">Note (optional)</Label>
              <Input id="note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button type="submit" className="sm:col-span-2" disabled={busy === "create"}>
              {busy === "create" ? "Sending…" : "Send request"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <RequestList title="Requests to me" items={incoming} counterparty={(r) => `from ${r.requesterEmail}`}
        actions={(r) => r.status === "pending" && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => respond(r, "decline")}>Decline</Button>
            <Button size="sm" disabled={busy === r.id} onClick={() => respond(r, "pay")}>Pay</Button>
          </div>
        )} />
      <RequestList title="My requests" items={outgoing} counterparty={(r) => `to ${r.payerEmail}`} />
    </div>
  );
}

function RequestList({ title, items, counterparty, actions }: {
  title: string;
  items: PaymentRequest[];
  counterparty: (r: PaymentRequest) => string;
  actions?: (r: PaymentRequest) => React.ReactNode;
}) {
  const now = useSyncExternalStore(
    () => () => {},
    () => Date.now(),
    () => 0
  );
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing here yet.</p>
        ) : (
          <ul className="divide-y">
            {items.map((r) => {
              // Expiry is enforced server-side; this only reflects it before the daily job runs.
              const status = r.status === "pending" && now > 0 && r.expiresAt?.toMillis() < now ? "expired" : r.status;
              return (
                <li key={r.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums">{formatCents(r.amountCents)}</span>
                      <Badge variant={status === "pending" ? "default" : "outline"}>{status}</Badge>
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      {counterparty(r)}{r.note ? ` — ${r.note}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">{r.createdAt?.toDate().toLocaleString() ?? "…"}</p>
                  </div>
                  {status === "pending" && actions?.(r)}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
