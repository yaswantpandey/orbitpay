"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Globe, LayoutDashboard, LogOut, ShieldCheck, UserCheck, Zap } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/components/auth-provider";
import { signOut } from "@/lib/auth";

export default function Home() {
  const { user, profile, loading, mfaEnrolled } = useAuth();
  const router = useRouter();

  // If already authenticated and 2FA verified, automatically route to dashboard
  useEffect(() => {
    if (!loading && user && mfaEnrolled) {
      router.replace("/dashboard");
    }
  }, [loading, user, mfaEnrolled, router]);

  const isAuthenticated = !loading && !!user && mfaEnrolled;
  const userIdentifier = profile?.displayName || user?.displayName || user?.email;

  return (
    <div className="flex flex-col items-center justify-center py-12 sm:py-20 text-center">
      {/* Hero Badge */}
      <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
        <Zap className="size-3.5" /> OrbitPay by Ecotech Services — Fast, Simple & Secure
      </div>

      <h1 className="max-w-2xl text-4xl font-extrabold tracking-tight sm:text-6xl">
        The borderless wallet for the modern economy.
      </h1>

      <p className="mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
        OrbitPay gives you instant money transfers, multi-currency views, automated splits,
        and bank-grade two-factor security — all from a single lightweight dashboard.
      </p>

      {/* Action Buttons: Dynamically adjusted based on auth state */}
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        {isAuthenticated ? (
          <>
            <Link
              href="/dashboard"
              className={buttonVariants({ size: "lg", className: "gap-2" })}
            >
              <LayoutDashboard className="size-4" /> Go to Dashboard <ArrowRight className="size-4" />
            </Link>
            <Button
              variant="outline"
              size="lg"
              className="gap-2"
              onClick={() => signOut()}
            >
              <LogOut className="size-4" /> Sign out
            </Button>
          </>
        ) : (
          <>
            <Link href="/signup" className={buttonVariants({ size: "lg", className: "gap-2" })}>
              Create free account <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/login"
              className={buttonVariants({ variant: "outline", size: "lg" })}
            >
              Sign in to wallet
            </Link>
          </>
        )}
      </div>

      {isAuthenticated && userIdentifier && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          <span>Signed in as <span className="font-semibold text-foreground">{userIdentifier}</span></span>
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">Test mode — no real money is moved.</p>

      {/* Feature Highlights Grid */}
      <div className="mt-16 grid w-full max-w-4xl grid-cols-1 gap-6 sm:grid-cols-3 text-left">
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="mb-3 inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Zap className="size-5" />
          </div>
          <h3 className="font-semibold">Instant Transfers</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Send money to anyone using their email address with zero latency and instant balance updates.
          </p>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="mb-3 inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Globe className="size-5" />
          </div>
          <h3 className="font-semibold">Multi-Currency Rates</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            View your balances in EUR, GBP, JPY, and more at live indicative exchange rates anytime.
          </p>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="mb-3 inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="size-5" />
          </div>
          <h3 className="font-semibold">Authenticator 2FA</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Fortified with time-based one-time password (TOTP) two-factor authentication for maximum protection.
          </p>
        </div>
      </div>
    </div>
  );
}
