"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { v4 as uuid } from "uuid";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KycBanner } from "@/components/kyc-banner";
import { functions } from "@/lib/firebase";
import { formatCents } from "@/lib/format";
import { dollarsToCents, topupSchema } from "@/lib/schemas";
import { stripePromise } from "@/lib/stripe";

export default function AddMoneyPage() {
  const [method, setMethod] = useState<"card" | "bank">("card");
  const [amount, setAmount] = useState("");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [amountCents, setAmountCents] = useState(0);
  const [busy, setBusy] = useState(false);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    const cents = dollarsToCents(amount);
    if (cents === null) return toast.error("Enter a valid amount");
    const parsed = topupSchema.safeParse({ amountCents: cents, method, idempotencyKey: uuid() });
    if (!parsed.success) return toast.error("Amount must be between $1.00 and $5,000.00");
    setBusy(true);
    try {
      const res = await httpsCallable<typeof parsed.data, { clientSecret: string }>(functions, "createTopup")(parsed.data);
      setAmountCents(cents);
      setClientSecret(res.data.clientSecret);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <KycBanner />
      <Card>
        <CardHeader>
          <CardTitle>Add money</CardTitle>
          <CardDescription>
            Your balance updates once the payment is confirmed. Bank debits stay pending until they clear.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {clientSecret ? (
            <Elements stripe={stripePromise} options={{ clientSecret }}>
              <PayForm amountCents={amountCents} onCancel={() => setClientSecret(null)} />
            </Elements>
          ) : (
            <form onSubmit={start} className="space-y-4">
              <Tabs value={method} onValueChange={(v) => setMethod(v as "card" | "bank")}>
                <TabsList className="w-full">
                  <TabsTrigger value="card">Card</TabsTrigger>
                  <TabsTrigger value="bank">Bank (ACH)</TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="space-y-2">
                <Label htmlFor="amount">Amount (USD)</Label>
                <Input id="amount" inputMode="decimal" placeholder="0.00" required value={amount}
                  onChange={(e) => setAmount(e.target.value)} />
                <div className="flex gap-1.5 pt-1">
                  {["25", "50", "100", "250"].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setAmount(preset)}
                      className="rounded-md border bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={busy}>Continue</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PayForm({ amountCents, onCancel }: { amountCents: number; onCancel: () => void }) {
  const router = useRouter();
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/dashboard` },
      redirect: "if_required",
    });
    setBusy(false);
    if (error) return toast.error(error.message ?? "Payment failed");
    // The wallet is credited by the Stripe webhook, not here.
    toast.success("Payment submitted. Your balance will update shortly.");
    router.push("/dashboard");
  }

  return (
    <form onSubmit={pay} className="space-y-4">
      <PaymentElement />
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={onCancel} disabled={busy}>Back</Button>
        <Button type="submit" className="flex-1" disabled={!stripe || busy}>Pay {formatCents(amountCents)}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Test card: 4242 4242 4242 4242, any future date, any CVC.</p>
    </form>
  );
}
