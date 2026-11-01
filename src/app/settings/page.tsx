"use client";

import { doc, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/components/auth-provider";
import { db, functions } from "@/lib/firebase";
import { CURRENCIES } from "@/lib/format";
import { signOut } from "@/lib/auth";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";

import { useSyncExternalStore } from "react";

export default function SettingsPage() {
  const { user, profile, mfaEnrolled } = useAuth();
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );





  async function changeCurrency(displayCurrency: string) {
    if (!user) return;
    try {
      // Only field the security rules allow the client to write.
      await updateDoc(doc(db, "users", user.uid), { displayCurrency });
      toast.success(`Display currency set to ${displayCurrency}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function refreshFx() {
    try {
      await httpsCallable(functions, "devRefreshFx")({});
      toast.success("Exchange rates refreshed");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>{profile?.email ?? user?.email}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span>Identity verification</span>
            <Badge variant={profile?.kycStatus === "verified" ? "default" : "outline"}>{profile?.kycStatus ?? "—"}</Badge>
          </div>
          <div className="flex justify-between"><span>Account tier</span><span>{profile?.tier ?? 0}</span></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Display currency</CardTitle>
          <CardDescription>Your balance is held in USD. Other currencies are shown at indicative rates.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          <Label htmlFor="currency">Currency</Label>
          <select id="currency" value={profile?.displayCurrency ?? "USD"} onChange={(e) => changeCurrency(e.target.value)}
            className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {process.env.NEXT_PUBLIC_USE_EMULATORS === "true" && (
            <Button variant="outline" size="sm" className="mt-2" onClick={refreshFx}>Refresh rates (dev only)</Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Customize the look and feel of the application.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label>Theme</Label>
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant={mounted && theme === "light" ? "default" : "outline"}
              className="flex items-center justify-center gap-2"
              onClick={() => setTheme("light")}
            >
              <Sun className="size-4" />
              <span>Light</span>
            </Button>
            <Button
              type="button"
              variant={mounted && theme === "dark" ? "default" : "outline"}
              className="flex items-center justify-center gap-2"
              onClick={() => setTheme("dark")}
            >
              <Moon className="size-4" />
              <span>Dark</span>
            </Button>
            <Button
              type="button"
              variant={mounted && theme === "system" ? "default" : "outline"}
              className="flex items-center justify-center gap-2"
              onClick={() => setTheme("system")}
            >
              <Monitor className="size-4" />
              <span>System</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>Email me about payments, requests, invoices and account changes</span>
            <input type="checkbox" className="size-4" checked={profile?.emailNotifications !== false}
              onChange={(e) => user && updateDoc(doc(db, "users", user.uid), { emailNotifications: e.target.checked })
                .then(() => toast.success(e.target.checked ? "Email notifications on" : "Email notifications off"))
                .catch((err) => toast.error((err as Error).message))} />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span>Two-factor authentication (authenticator app)</span>
            <Badge variant={mfaEnrolled ? "default" : "outline"}>{mfaEnrolled ? "On" : "Off"}</Badge>
          </div>
          <Button variant="outline" onClick={() => signOut()}>Sign out</Button>
        </CardContent>
      </Card>
    </div>
  );
}
