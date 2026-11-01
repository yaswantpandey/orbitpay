"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Wallet, Send, PlusCircle, History, Settings, LogOut, HandCoins, FileText, MoreHorizontal,
  Landmark, Users, Split, Repeat, BarChart3, Shield, Coins, PiggyBank, Store, QrCode,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth } from "@/components/auth-provider";
import { NotificationBell } from "@/components/notification-bell";
import { ThemeToggle } from "@/components/theme-toggle";
import { signOut } from "@/lib/auth";
import { useIsAdmin } from "@/lib/hooks";

const PRIMARY = [
  { href: "/dashboard", label: "Wallet", icon: Wallet },
  { href: "/send", label: "Send", icon: Send },
  { href: "/requests", label: "Requests", icon: HandCoins },
  { href: "/history", label: "History", icon: History },
];

const MORE = [
  { href: "/add-money", label: "Add money", icon: PlusCircle },
  { href: "/withdraw", label: "Withdraw", icon: Landmark },
  { href: "/currencies", label: "Currencies", icon: Coins },
  { href: "/savings", label: "Savings goals", icon: PiggyBank },
  { href: "/contacts", label: "Contacts & QR", icon: Users },
  { href: "/split", label: "Split a bill", icon: Split },
  { href: "/recurring", label: "Recurring", icon: Repeat },
  { href: "/invoices", label: "Invoices", icon: FileText },
  { href: "/merchant", label: "Merchant", icon: Store },
  { href: "/insights", label: "Insights", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav() {
  const { user, profile, mfaEnrolled } = useAuth();
  const isAdmin = useIsAdmin();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [prevPath, setPrevPath] = useState(pathname);
  const ref = useRef<HTMLDivElement>(null);

  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Public visitor navbar (unauthenticated)
  if (!user || !mfaEnrolled) {
    return (
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-2.5">
          <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <Wallet className="size-5 text-primary" />
            <span>OrbitPay</span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link
              href="/login"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className={buttonVariants({ size: "sm" })}
            >
              Get started
            </Link>
          </div>
        </div>
      </header>
    );
  }

  const more = isAdmin ? [...MORE, { href: "/admin", label: "Admin", icon: Shield }] : MORE;
  const moreActive = more.some((l) => l.href === pathname);

  const userInitials = profile?.displayName
    ? profile.displayName
        .split(" ")
        .map((n) => n[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : user?.email
    ? user.email.slice(0, 2).toUpperCase()
    : "OP";

  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-md">
      {/* 1. Mobile Top App Bar (< md) */}
      <div className="flex md:hidden items-center justify-between px-3.5 py-2.5">
        <Link href="/settings" className="flex items-center gap-2 active:scale-95 transition">
          <Avatar className="size-8 ring-2 ring-primary/20">
            <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
              {userInitials}
            </AvatarFallback>
          </Avatar>
        </Link>

        <Link href="/dashboard" className="flex items-center gap-1.5 font-bold text-base tracking-tight">
          <Wallet className="size-4.5 text-primary" />
          <span>OrbitPay</span>
        </Link>

        <div className="flex items-center gap-1">
          <Link
            href="/contacts"
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground active:scale-95 transition"
            aria-label="Scan or Show QR"
          >
            <QrCode className="size-4.5" />
          </Link>
          <NotificationBell />
          <ThemeToggle />
        </div>
      </div>

      {/* 2. Desktop Navigation Bar (>= md) */}
      <div className="hidden md:flex mx-auto max-w-5xl items-center gap-1 px-4 py-2">
        <Link href="/dashboard" className="mr-4 flex items-center gap-2 text-lg font-bold">
          <Wallet className="size-5 text-primary" />
          <span>OrbitPay</span>
        </Link>
        {PRIMARY.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
              pathname === href ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"
            }`}>
            <Icon className="size-4" />
            <span>{label}</span>
          </Link>
        ))}
        <div ref={ref} className="relative">
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu"
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
              moreActive ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"
            }`}>
            <MoreHorizontal className="size-4" />
            <span>More</span>
          </button>
          {open && (
            <div role="menu" className="absolute left-0 z-50 mt-2 w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
              {more.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} role="menuitem"
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted ${pathname === href ? "bg-muted font-medium" : ""}`}>
                  <Icon className="size-4" /> {label}
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <NotificationBell />
          <ThemeToggle />
          <Button variant="ghost" size="sm" aria-label="Sign out" onClick={() => signOut()}>
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </header>
  );
}
