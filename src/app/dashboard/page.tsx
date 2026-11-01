"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Send,
  PlusCircle,
  HandCoins,
  Split,
  PiggyBank,
  Coins,
  ShieldCheck,
  AlertCircle,
  ArrowUpRight,
  ArrowDownLeft,
  ChevronRight,
  UserPlus,
  Clock,

} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { BalanceCard } from "@/components/balance-card";
import { KycBanner } from "@/components/kyc-banner";
import { TransactionList } from "@/components/transaction-list";
import { useAuth } from "@/components/auth-provider";
import {
  useContacts,
  useInvoices,
  useLedger,
  usePaymentRequests,
  usePots,
} from "@/lib/hooks";
import { formatCents } from "@/lib/format";

export default function DashboardPage() {
  const { user, profile } = useAuth();
  const recent = useLedger(6);
  const contacts = useContacts();
  const pots = usePots();
  const requests = usePaymentRequests();
  const { received: receivedInvoices } = useInvoices();

  // Greeting, Date & Monthly Stats (evaluated in client after mount to prevent prerender time instability)
  const [greeting, setGreeting] = useState("Welcome back");
  const [formattedDate, setFormattedDate] = useState("");
  const [monthlyInCents, setMonthlyInCents] = useState(0);
  const [monthlyOutCents, setMonthlyOutCents] = useState(0);

  useEffect(() => {
    const now = new Date();
    const hour = now.getHours();
    const g = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const d = now.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    queueMicrotask(() => {
      setGreeting(g);
      setFormattedDate(d);
    });

    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    let inCents = 0;
    let outCents = 0;

    for (const e of recent) {
      if (!e.createdAt) continue;
      const date = e.createdAt.toDate();
      if (date.getMonth() === currentMonth && date.getFullYear() === currentYear) {
        if (e.amountCents > 0) inCents += e.amountCents;
        else outCents += Math.abs(e.amountCents);
      }
    }

    queueMicrotask(() => {
      setMonthlyInCents(inCents);
      setMonthlyOutCents(outCents);
    });
  }, [recent]);

  // Pending Actions
  const pendingRequestsToPay = useMemo(() => {
    if (!user) return [];
    return requests.filter((r) => r.payerUid === user.uid && r.status === "pending");
  }, [requests, user]);

  const unpaidInvoicesToPay = useMemo(() => {
    return receivedInvoices.filter((i) => i.status === "sent");
  }, [receivedInvoices]);

  const displayName = profile?.displayName || user?.displayName || user?.email?.split("@")[0] || "there";

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Top Header / Greeting */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight sm:text-3xl">
              {greeting}, {displayName}
            </h1>
            {profile?.kycStatus === "verified" ? (
              <Badge variant="default" className="gap-1 bg-emerald-600 hover:bg-emerald-600/90 text-white text-[10px] py-0.5">
                <ShieldCheck className="size-3" /> Verified
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground text-[10px] py-0.5">
                Tier {profile?.tier ?? 0}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{formattedDate}</p>
        </div>

        {/* Desktop Quick Header Buttons */}
        <div className="hidden sm:flex items-center gap-2">
          <Link
            href="/send"
            className={buttonVariants({ size: "sm", className: "gap-1.5 rounded-xl" })}
          >
            <Send className="size-3.5" /> Send
          </Link>
          <Link
            href="/add-money"
            className={buttonVariants({ size: "sm", variant: "outline", className: "gap-1.5 rounded-xl" })}
          >
            <PlusCircle className="size-3.5" /> Add money
          </Link>
        </div>
      </div>

      <KycBanner />

      {/* Attention / Action Required Alerts */}
      {(pendingRequestsToPay.length > 0 || unpaidInvoicesToPay.length > 0) && (
        <div className="space-y-2">
          {pendingRequestsToPay.length > 0 && (
            <div className="flex items-center justify-between rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 sm:p-4 text-amber-900 dark:text-amber-200">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="size-4.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="text-xs sm:text-sm">
                  <span className="font-semibold">
                    {pendingRequestsToPay.length} payment request{pendingRequestsToPay.length > 1 ? "s" : ""}
                  </span>{" "}
                  waiting for your response.
                </div>
              </div>
              <Link
                href="/requests"
                className={buttonVariants({ size: "sm", variant: "outline", className: "rounded-xl border-amber-500/40 text-xs h-8" })}
              >
                Review
              </Link>
            </div>
          )}

          {unpaidInvoicesToPay.length > 0 && (
            <div className="flex items-center justify-between rounded-2xl border border-blue-500/30 bg-blue-500/10 p-3.5 sm:p-4 text-blue-900 dark:text-blue-200">
              <div className="flex items-center gap-2.5">
                <Clock className="size-4.5 shrink-0 text-blue-600 dark:text-blue-400" />
                <div className="text-xs sm:text-sm">
                  <span className="font-semibold">
                    {unpaidInvoicesToPay.length} unpaid invoice{unpaidInvoicesToPay.length > 1 ? "s" : ""}
                  </span>{" "}
                  received.
                </div>
              </div>
              <Link
                href="/invoices"
                className={buttonVariants({ size: "sm", variant: "outline", className: "rounded-xl border-blue-500/40 text-xs h-8" })}
              >
                View
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Main Grid: Balance & Quick Actions */}
      <div className="grid gap-4 sm:gap-6 md:grid-cols-[1.5fr_1fr]">
        <BalanceCard />

        {/* Quick Action Matrix (Desktop Only, as Mobile has native action pills in BalanceCard & Bottom Nav) */}
        <Card className="hidden md:flex flex-col justify-between rounded-3xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Quick Actions</CardTitle>
            <CardDescription>Instant payments and account tools</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2.5">
            <Link
              href="/send"
              className="flex items-center gap-2.5 rounded-xl border bg-card p-3 text-sm font-medium transition hover:bg-muted active:scale-95"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Send className="size-4" />
              </div>
              <span>Send</span>
            </Link>

            <Link
              href="/add-money"
              className="flex items-center gap-2.5 rounded-xl border bg-card p-3 text-sm font-medium transition hover:bg-muted active:scale-95"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PlusCircle className="size-4" />
              </div>
              <span>Add funds</span>
            </Link>

            <Link
              href="/requests"
              className="flex items-center gap-2.5 rounded-xl border bg-card p-3 text-sm font-medium transition hover:bg-muted active:scale-95"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <HandCoins className="size-4" />
              </div>
              <span>Request</span>
            </Link>

            <Link
              href="/split"
              className="flex items-center gap-2.5 rounded-xl border bg-card p-3 text-sm font-medium transition hover:bg-muted active:scale-95"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Split className="size-4" />
              </div>
              <span>Split bill</span>
            </Link>

            <Link
              href="/savings"
              className="flex items-center gap-2.5 rounded-xl border bg-card p-3 text-sm font-medium transition hover:bg-muted active:scale-95"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PiggyBank className="size-4" />
              </div>
              <span>Savings</span>
            </Link>

            <Link
              href="/currencies"
              className="flex items-center gap-2.5 rounded-xl border bg-card p-3 text-sm font-medium transition hover:bg-muted active:scale-95"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Coins className="size-4" />
              </div>
              <span>Currencies</span>
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Monthly Cash Flow Stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <div className="rounded-2xl border bg-card p-4 sm:p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Received</p>
              <p className="mt-1 text-lg sm:text-xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                +{formatCents(monthlyInCents)}
              </p>
            </div>
            <div className="flex size-9 sm:size-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <ArrowDownLeft className="size-4.5 sm:size-5" />
            </div>
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-4 sm:p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Spent</p>
              <p className="mt-1 text-lg sm:text-xl font-bold tabular-nums text-rose-600 dark:text-rose-400">
                −{formatCents(monthlyOutCents)}
              </p>
            </div>
            <div className="flex size-9 sm:size-10 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
              <ArrowUpRight className="size-4.5 sm:size-5" />
            </div>
          </div>
        </div>
      </div>

      {/* Quick Send to Contacts */}
      <div className="rounded-2xl sm:rounded-3xl border bg-card p-4 sm:p-5 shadow-xs">
        <div className="flex items-center justify-between pb-3">
          <div>
            <h2 className="text-sm sm:text-base font-bold">Quick Send</h2>
            <p className="text-xs text-muted-foreground">Send money in one tap to saved contacts</p>
          </div>
          <Link href="/contacts" className="text-xs font-medium text-primary hover:underline">
            Manage
          </Link>
        </div>
        <div>
          <div className="flex items-center gap-3.5 overflow-x-auto pb-1 no-scrollbar">
            <Link
              href="/contacts"
              className="flex flex-col items-center gap-1.5 text-center group shrink-0 active:scale-90 transition"
            >
              <div className="flex size-12 items-center justify-center rounded-full border border-dashed border-border group-hover:border-primary group-hover:bg-primary/5 transition">
                <UserPlus className="size-5 text-muted-foreground group-hover:text-primary transition" />
              </div>
              <span className="text-[11px] text-muted-foreground group-hover:text-foreground">Add new</span>
            </Link>

            {contacts.map((c) => {
              const initials = c.name
                ? c.name
                    .split(" ")
                    .map((n) => n[0])
                    .slice(0, 2)
                    .join("")
                    .toUpperCase()
                : c.email.slice(0, 2).toUpperCase();

              return (
                <Link
                  key={c.id}
                  href={`/send?to=${encodeURIComponent(c.email)}`}
                  className="flex flex-col items-center gap-1.5 text-center group shrink-0 active:scale-90 transition"
                >
                  <Avatar className="size-12 ring-2 ring-transparent group-hover:ring-primary transition">
                    <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <span className="max-w-[70px] truncate text-[11px] font-medium group-hover:text-primary">
                    {c.name || c.email.split("@")[0]}
                  </span>
                </Link>
              );
            })}

            {contacts.length === 0 && (
              <p className="text-xs text-muted-foreground pl-2 py-2">
                No saved contacts yet. Tap + to add someone.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Two Column Section: Savings Pots & Recent Transactions */}
      <div className="grid gap-4 sm:gap-6 md:grid-cols-[1fr_1.5fr]">
        {/* Savings Goals Preview */}
        <div className="flex flex-col justify-between rounded-2xl sm:rounded-3xl border bg-card p-4 sm:p-5 shadow-xs">
          <div className="flex items-center justify-between pb-3">
            <div>
              <h2 className="text-sm sm:text-base font-bold">Savings Goals</h2>
              <p className="text-xs text-muted-foreground">Pockets set aside</p>
            </div>
            <Link href="/savings" className="text-xs font-medium text-primary hover:underline">
              View all
            </Link>
          </div>
          <div className="space-y-3 py-1">
            {pots.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center">
                <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <PiggyBank className="size-5" />
                </div>
                <p className="text-xs text-muted-foreground">No active savings pots.</p>
                <Link
                  href="/savings"
                  className={buttonVariants({ variant: "outline", size: "sm", className: "mt-3 text-xs rounded-xl" })}
                >
                  Create a goal
                </Link>
              </div>
            ) : (
              pots.slice(0, 2).map((pot) => {
                const pct = pot.targetCents > 0 ? Math.min(100, Math.round((pot.balanceCents / pot.targetCents) * 100)) : 100;
                return (
                  <div key={pot.id} className="space-y-1.5 rounded-xl border p-3">
                    <div className="flex items-center justify-between text-xs font-medium">
                      <span>{pot.name}</span>
                      <span className="tabular-nums font-semibold">{pct}%</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary transition-all duration-500 rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                      <span>{formatCents(pot.balanceCents)}</span>
                      <span>Target: {formatCents(pot.targetCents)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t pt-3 mt-2">
            <Link
              href="/savings"
              className="flex items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <span>Manage all goals</span>
              <ChevronRight className="size-3.5" />
            </Link>
          </div>
        </div>

        {/* Recent Transactions Feed */}
        <div className="rounded-2xl sm:rounded-3xl border bg-card p-4 sm:p-5 shadow-xs">
          <div className="flex items-center justify-between pb-3">
            <div>
              <h2 className="text-sm sm:text-base font-bold">Recent Activity</h2>
              <p className="text-xs text-muted-foreground">Latest wallet movements</p>
            </div>
            <Link href="/history" className="text-xs font-medium text-primary hover:underline">
              View all
            </Link>
          </div>
          <div>
            <TransactionList entries={recent} />
          </div>
        </div>
      </div>
    </div>
  );
}
