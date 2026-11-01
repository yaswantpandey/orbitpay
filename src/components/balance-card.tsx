"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, Plus, Send, ArrowDownLeft, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/format";
import { useDisplayRate, usePendingTopups, useWallet } from "@/lib/hooks";

export function BalanceCard() {
  const [masked, setMasked] = useState(false);
  const wallet = useWallet();
  const pending = usePendingTopups();
  const { currency, rate } = useDisplayRate();
  const balance = wallet?.balanceCents ?? 0;
  const pendingCents = pending.reduce((s, t) => s + t.amountCents, 0);

  return (
    <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl border border-border/80 bg-gradient-to-br from-card via-card to-muted/40 p-5 sm:p-6 shadow-sm">
      {/* Decorative background glow */}
      <div className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-primary/5 blur-2xl" />

      {/* Top Card Bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            OrbitPay Wallet
          </span>
          <span className="flex size-2 rounded-full bg-emerald-500 animate-pulse" />
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="size-8 rounded-full p-0 text-muted-foreground hover:text-foreground active:scale-95 transition"
          aria-label={masked ? "Show balance" : "Hide balance"}
          onClick={() => setMasked(!masked)}
        >
          {masked ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </Button>
      </div>

      {/* Main Balance Display */}
      <div className="mt-3">
        <div className="text-3xl sm:text-4xl font-extrabold tracking-tight tabular-nums">
          {masked ? "$••••••" : wallet ? formatCents(balance) : "—"}
        </div>

        {/* Currency conversion and pending notes */}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {currency !== "USD" && !masked && (
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 font-medium text-primary">
              ≈ {formatCents(balance, currency, rate)} {currency}
            </span>
          )}
          {pendingCents > 0 && (
            <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">
              Pending: {masked ? "$•••" : formatCents(pendingCents)}
            </span>
          )}
        </div>
      </div>

      {/* Mobile-First Action Pill Buttons (Native App Quick Actions) */}
      <div className="mt-5 grid grid-cols-4 gap-2 pt-2 border-t border-border/50">
        <Link
          href="/send"
          className="flex flex-col items-center gap-1 rounded-xl p-2 text-center transition active:scale-90 hover:bg-muted/60"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs">
            <Send className="size-4" />
          </div>
          <span className="text-[11px] font-medium">Send</span>
        </Link>

        <Link
          href="/add-money"
          className="flex flex-col items-center gap-1 rounded-xl p-2 text-center transition active:scale-90 hover:bg-muted/60"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted border border-border text-foreground shadow-xs">
            <Plus className="size-4" />
          </div>
          <span className="text-[11px] font-medium">Add</span>
        </Link>

        <Link
          href="/requests"
          className="flex flex-col items-center gap-1 rounded-xl p-2 text-center transition active:scale-90 hover:bg-muted/60"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted border border-border text-foreground shadow-xs">
            <ArrowDownLeft className="size-4" />
          </div>
          <span className="text-[11px] font-medium">Request</span>
        </Link>

        <Link
          href="/contacts"
          className="flex flex-col items-center gap-1 rounded-xl p-2 text-center transition active:scale-90 hover:bg-muted/60"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted border border-border text-foreground shadow-xs">
            <QrCode className="size-4" />
          </div>
          <span className="text-[11px] font-medium">Scan QR</span>
        </Link>
      </div>
    </div>
  );
}
