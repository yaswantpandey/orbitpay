"use client";

import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KycBanner } from "@/components/kyc-banner";
import { functions } from "@/lib/firebase";
import { formatCents } from "@/lib/format";
import { useApiKeys, useCheckouts, useMerchant, useWebhookDeliveries } from "@/lib/hooks";
import { dollarsToCents } from "@/lib/schemas";

const DEV = process.env.NEXT_PUBLIC_USE_EMULATORS === "true";
const API_BASE = DEV
  ? `http://127.0.0.1:5001/${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "demo-fastpay"}/us-central1/api`
  : `https://us-central1-${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}.cloudfunctions.net/api`;
const copy = (s: string, what: string) => navigator.clipboard.writeText(s).then(() => toast.success(`${what} copied`));
const call = (name: string, data: unknown) => httpsCallable(functions, name)(data);

export default function MerchantPage() {
  const merchant = useMerchant();
  const keys = useApiKeys();
  const checkouts = useCheckouts();
  const deliveries = useWebhookDeliveries();
  const [businessName, setBusinessName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!merchant) return;
    queueMicrotask(() => {
      setBusinessName(merchant.businessName);
      setWebhookUrl(merchant.webhookUrl);
    });
  }, [merchant]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const saveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => call("setMerchantProfile", { businessName: businessName.trim(), webhookUrl: webhookUrl.trim() }), "Merchant profile saved");
  };

  const createKey = () => run(async () => {
    const { data } = await httpsCallable<unknown, { key: string }>(functions, "createApiKey")({});
    setNewKey(data.key);
  });

  const createLink = (e: React.FormEvent) => {
    e.preventDefault();
    const amountCents = dollarsToCents(amount);
    if (!amountCents) return toast.error("Enter an amount, e.g. 19.99");
    run(async () => {
      const { data } = await httpsCallable<unknown, { url: string }>(functions, "createCheckout")({ amountCents, description: description.trim() || "Payment" });
      await copy(data.url, "Payment link");
      setAmount(""); setDescription("");
    });
  };

  if (merchant === undefined) return <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <KycBanner />
      <Card>
        <CardHeader>
          <CardTitle>{merchant ? "Merchant profile" : "Accept payments"}</CardTitle>
          <CardDescription>Get paid by any OrbitPay user through a hosted checkout page or the API.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={saveProfile} className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="biz">Business name</Label>
              <Input id="biz" required maxLength={100} value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hook">Webhook URL (optional)</Label>
              <Input id="hook" type="url" placeholder="https://example.com/orbitpay/webhook" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
            </div>
            <Button type="submit" className="sm:col-span-2" disabled={busy}>{merchant ? "Save" : "Enable merchant mode"}</Button>
          </form>
          {merchant && (
            <div className="space-y-1 text-sm">
              <Label>Webhook signing secret</Label>
              <div className="flex gap-2">
                <code className="flex-1 truncate rounded border bg-muted px-2 py-1 text-xs">{merchant.webhookSecret}</code>
                <Button size="sm" variant="outline" onClick={() => copy(merchant.webhookSecret, "Secret")}><Copy className="size-4" /></Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Verify the <code>OrbitPay-Signature</code> header: <code>v1 = HMAC_SHA256(secret, t + &quot;.&quot; + body)</code>; reject if <code>t</code> is older than 5 minutes.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {merchant && (
        <>
          <Card>
            <CardHeader><CardTitle>Payment link</CardTitle><CardDescription>Create a one-time checkout and copy its link.</CardDescription></CardHeader>
            <CardContent>
              <form onSubmit={createLink} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                <div className="space-y-1">
                  <Label htmlFor="amt">Amount (USD)</Label>
                  <Input id="amt" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="desc">Description</Label>
                  <Input id="desc" maxLength={200} placeholder="Order #1234" value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
                <Button type="submit" disabled={busy}>Create link</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>API keys</CardTitle>
                <CardDescription className="break-all">Base URL: <code>{API_BASE}</code></CardDescription>
              </div>
              <Button size="sm" onClick={createKey} disabled={busy}><KeyRound className="size-4" /> New key</Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {newKey && (
                <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-medium">Copy this key now — it won&apos;t be shown again.</p>
                  <div className="flex gap-2">
                    <code className="flex-1 break-all rounded bg-white px-2 py-1 text-xs">{newKey}</code>
                    <Button size="sm" variant="outline" onClick={() => copy(newKey, "Key")}><Copy className="size-4" /></Button>
                  </div>
                  <pre className="overflow-x-auto rounded bg-white p-2 text-xs">{`curl -X POST ${API_BASE}/v1/checkouts \\
  -H "Authorization: Bearer ${newKey.slice(0, 12)}…" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1234" \\
  -d '{"amountCents":1999,"description":"Order #1234"}'`}</pre>
                  <Button size="sm" variant="ghost" onClick={() => setNewKey(null)}>Done</Button>
                </div>
              )}
              <ul className="divide-y text-sm">
                {keys.map((k) => (
                  <li key={k.id} className="flex items-center justify-between py-2">
                    <span><code>{k.prefix}…</code> <span className="text-xs text-muted-foreground">{k.createdAt?.toDate().toLocaleDateString()}</span></span>
                    {k.revoked ? <Badge variant="outline">revoked</Badge> : (
                      <Button size="sm" variant="ghost" disabled={busy}
                        onClick={() => confirm("Revoke this key? Integrations using it will stop working.") &&
                          run(() => call("revokeApiKey", { keyId: k.id }), "Key revoked")}>
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
                {keys.length === 0 && <li className="py-4 text-center text-muted-foreground">No keys yet.</li>}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Checkouts</CardTitle></CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {checkouts.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.description}</span>
                      <span className="text-xs text-muted-foreground">
                        {c.createdAt?.toDate().toLocaleString()}{c.reference ? ` · ref ${c.reference}` : ""}{c.payerEmail ? ` · ${c.payerEmail}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge variant={c.status === "paid" ? "secondary" : "outline"}>{c.status}</Badge>
                      <span className="tabular-nums">{formatCents(c.amountCents)}</span>
                    </span>
                  </li>
                ))}
                {checkouts.length === 0 && <li className="py-4 text-center text-muted-foreground">No checkouts yet.</li>}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Webhook deliveries</CardTitle>
              {DEV && <Button size="sm" variant="outline" onClick={() => run(() => call("devRetryWebhooks", {}), "Retried")}>Retry now (dev only)</Button>}
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {deliveries.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="font-mono text-xs">{d.type}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {d.attempts} attempt{d.attempts === 1 ? "" : "s"}{d.lastStatus ? ` · HTTP ${d.lastStatus}` : ""}{d.lastError ? ` · ${d.lastError}` : ""}
                      </span>
                    </span>
                    <Badge variant={d.status === "delivered" ? "secondary" : d.status === "failed" ? "destructive" : "outline"}>{d.status}</Badge>
                  </li>
                ))}
                {deliveries.length === 0 && <li className="py-4 text-center text-muted-foreground">No deliveries yet.</li>}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
