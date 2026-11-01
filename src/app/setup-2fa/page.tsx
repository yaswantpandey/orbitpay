"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TotpSecret } from "firebase/auth";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/components/auth-provider";
import { startTotpEnrollment, finishTotpEnrollment, signOut } from "@/lib/auth";

export default function Setup2faPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [secret, setSecret] = useState<TotpSecret | null>(null);
  const [qrUrl, setQrUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!user) return;
    setBusy(true);
    try {
      const r = await startTotpEnrollment(user);
      setSecret(r.secret);
      setQrUrl(r.qrUrl);
    } catch (e) {
      const msg = (e as { code?: string }).code === "auth/requires-recent-login"
        ? "Please sign out and sign in again, then retry."
        : (e as Error).message;
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !secret) return;
    setBusy(true);
    try {
      await finishTotpEnrollment(user, secret, code);
      toast.success("Two-factor authentication enabled");
      router.push("/dashboard");
    } catch {
      toast.error("Invalid code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>Secure your account</CardTitle>
        <CardDescription>
          Two-factor authentication is required before you can use your wallet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!secret ? (
          <Button className="w-full" onClick={start} disabled={busy}>Set up authenticator app</Button>
        ) : (
          <form onSubmit={finish} className="space-y-4">
            <p className="text-sm">
              Add this key to Google Authenticator, 1Password, Authy or similar
              (or open the link on your phone):
            </p>
            <code className="block break-all rounded bg-muted p-2 text-sm">{secret.secretKey}</code>
            <a href={qrUrl} className="block break-all text-xs text-muted-foreground underline">{qrUrl}</a>
            <div className="space-y-2">
              <Label htmlFor="code">6-digit code</Label>
              <Input id="code" inputMode="numeric" maxLength={6} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
            </div>
            <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>Enable 2FA</Button>
          </form>
        )}
        <Button variant="ghost" className="w-full" onClick={() => signOut()}>Sign out</Button>
      </CardContent>
    </Card>
  );
}
