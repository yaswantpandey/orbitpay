"use client";

import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KycBanner } from "@/components/kyc-banner";
import { functions } from "@/lib/firebase";
import { formatCents } from "@/lib/format";
import { useWallet } from "@/lib/hooks";

type View = {
  id: string; status: "open" | "paid" | "expired"; amountCents: number; description: string;
  businessName: string; successUrl: string | null;
};

/** Only follow merchant-supplied redirects over https (or http on localhost for testing). Rejects embedded credentials. */
function safeRedirect(url: string | null) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) return null;
    const isHttps = u.protocol === "https:";
    const isDevHttp = u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
    if (!isHttps && !isDevHttp) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export default function CheckoutPage() {
  const wallet = useWallet();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) {
      queueMicrotask(() => setError("Missing checkout id"));
      return;
    }
    httpsCallable<unknown, View>(functions, "getCheckout")({ checkoutId: id.slice(0, 200) })
      .then((r) => setView(r.data))
      .catch((e) => setError((e as Error).message));
  }, []);

  async function pay() {
    if (!view) return;
    setBusy(true);
    try {
      await httpsCallable(functions, "payCheckout")({ checkoutId: view.id });
      setView({ ...view, status: "paid" });
      toast.success(`Paid ${formatCents(view.amountCents)} to ${view.businessName}`);
      const next = safeRedirect(view.successUrl);
      if (next) setTimeout(() => window.location.assign(next), 1500);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="py-12 text-center text-sm text-muted-foreground">{error}</p>;
  if (!view) return <p className="py-12 text-center text-sm text-muted-foreground">Loading checkout…</p>;

  return (
    <div className="mx-auto max-w-sm space-y-4 pt-6">
      <KycBanner />
      <Card>
        <CardHeader className="text-center">
          <CardDescription>Pay {view.businessName}</CardDescription>
          <CardTitle className="text-3xl tabular-nums">{formatCents(view.amountCents)}</CardTitle>
          <p className="text-sm text-muted-foreground">{view.description}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {view.status === "paid" ? (
            <div className="space-y-3 text-center">
              <p className="flex items-center justify-center gap-2 font-medium text-green-600">
                <CheckCircle2 className="size-5" /> Paid successfully
              </p>
              {safeRedirect(view.successUrl) ? (
                <div className="space-y-2 pt-2 text-xs text-muted-foreground">
                  <p>Redirecting to <span className="font-semibold text-foreground">{new URL(safeRedirect(view.successUrl)!).hostname}</span>…</p>
                  <a
                    href={safeRedirect(view.successUrl)!}
                    rel="noopener noreferrer"
                    className="inline-block text-primary underline"
                  >
                    Click here if not redirected automatically
                  </a>
                </div>
              ) : null}
            </div>
          ) : view.status === "expired" ? (
            <p className="text-center text-sm text-muted-foreground">This checkout has expired.</p>
          ) : (
            <>
              <p className="text-center text-xs text-muted-foreground">
                From your OrbitPay balance ({wallet ? formatCents(wallet.balanceCents) : "—"} available)
              </p>
              <Button className="w-full" size="lg" onClick={pay}
                disabled={busy || (wallet ? wallet.balanceCents < view.amountCents : false)}>
                {busy ? "Paying…" : wallet && wallet.balanceCents < view.amountCents ? "Insufficient funds" : "Pay now"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
