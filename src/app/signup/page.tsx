"use client";

import { useState } from "react";
import Link from "next/link";
import type { MultiFactorResolver } from "firebase/auth";
import { toast } from "sonner";
import { Eye, EyeOff, Lock, Mail, User as UserIcon, Wallet, ArrowRight, ShieldCheck, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  signInWithGoogle,
  signUpWithEmail,
  resolveTotpSignIn,
} from "@/lib/auth";

export default function SignUpPage() {
  const [busy, setBusy] = useState(false);
  const [resolver, setResolver] = useState<MultiFactorResolver | null>(null);
  const [code, setCode] = useState("");

  // Registration form state
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(true);

  function mapAuthError(err: unknown): string {
    const message = (err as { code?: string; message?: string })?.code || (err as Error)?.message || "";
    if (message.includes("email-already-in-use")) {
      return "An account with this email address already exists. Try signing in.";
    }
    if (message.includes("weak-password")) {
      return "Password is too weak. Please use at least 6 characters.";
    }
    if (message.includes("invalid-email")) {
      return "Please enter a valid email address.";
    }
    if (message.includes("popup-closed-by-user")) {
      return "Google sign-in was cancelled.";
    }
    return (err as Error).message || "Registration failed. Please try again.";
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      toast.error("Please fill in all required fields.");
      return;
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters long.");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }
    if (!agreeTerms) {
      toast.error("Please accept the terms of service to continue.");
      return;
    }

    setBusy(true);
    try {
      const r = await signUpWithEmail(email, password, displayName);
      if (r.status === "mfa_required") {
        setResolver(r.resolver);
      } else {
        toast.success("Account created successfully! Welcome to OrbitPay.");
      }
    } catch (err) {
      toast.error(mapAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogleSignUp() {
    setBusy(true);
    try {
      const r = await signInWithGoogle();
      if (r.status === "mfa_required") {
        setResolver(r.resolver);
      } else {
        toast.success("Welcome to OrbitPay!");
      }
    } catch (err) {
      toast.error(mapAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifyMfa(e: React.FormEvent) {
    e.preventDefault();
    if (!resolver) return;
    setBusy(true);
    try {
      await resolveTotpSignIn(resolver, code);
      toast.success("Authentication verified!");
    } catch {
      toast.error("Invalid verification code. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const passwordValid = password.length >= 6;
  const passwordsMatch = password.length > 0 && password === confirmPassword;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center space-y-6 pt-4 pb-12 sm:pt-8">
      {/* Brand Header */}
      <div className="flex flex-col items-center space-y-2 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-md">
          <Wallet className="size-6" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Create your OrbitPay account</h1>
        <p className="text-xs text-muted-foreground">Start sending, holding, and receiving money globally</p>
      </div>

      <Card className="border-border/60 shadow-lg">
        {resolver ? (
          // MFA 2FA verification step
          <>
            <CardHeader className="space-y-1">
              <div className="flex items-center gap-2 text-primary">
                <ShieldCheck className="size-5" />
                <CardTitle className="text-xl">Two-Factor Authentication</CardTitle>
              </div>
              <CardDescription>
                Enter the 6-digit verification code from your authenticator app.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={verifyMfa} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="mfa-code">Authenticator Code</Label>
                  <Input
                    id="mfa-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    className="text-center text-lg tracking-widest font-mono"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    autoFocus
                  />
                </div>
                <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
                  {busy ? "Verifying..." : "Verify Code"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-xs text-muted-foreground"
                  onClick={() => setResolver(null)}
                >
                  Back to Registration
                </Button>
              </form>
            </CardContent>
          </>
        ) : (
          // Registration Form
          <>
            <CardHeader className="space-y-1">
              <CardTitle className="text-xl">Sign up</CardTitle>
              <CardDescription>
                Join thousands of users managing borderless funds securely.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Google Sign Up */}
              <Button
                variant="outline"
                className="w-full flex items-center justify-center gap-2"
                onClick={handleGoogleSignUp}
                disabled={busy}
              >
                <svg className="size-4" viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="currentColor"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                Sign up with Google
              </Button>

              <div className="relative flex items-center justify-center">
                <Separator className="w-full" />
                <span className="absolute bg-card px-2 text-xs uppercase text-muted-foreground">
                  Or register with email
                </span>
              </div>

              {/* Form */}
              <form onSubmit={handleSignUp} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="displayName">Full Name</Label>
                  <div className="relative">
                    <UserIcon className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                    <Input
                      id="displayName"
                      type="text"
                      placeholder="Jane Doe"
                      className="pl-9"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="signup-email">Email Address</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                    <Input
                      id="signup-email"
                      type="email"
                      placeholder="you@example.com"
                      className="pl-9"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="signup-password">Password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                    <Input
                      id="signup-password"
                      type={showPassword ? "text" : "password"}
                      placeholder="At least 6 characters"
                      className="pl-9 pr-9"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={6}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirm-password">Confirm Password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                    <Input
                      id="confirm-password"
                      type={showConfirmPassword ? "text" : "password"}
                      placeholder="Re-enter password"
                      className="pl-9 pr-9"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
                    >
                      {showConfirmPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                  {confirmPassword && (
                    <div className="flex items-center gap-1.5 pt-1 text-xs">
                      {passwordsMatch ? (
                        <span className="flex items-center text-emerald-600 dark:text-emerald-400">
                          <Check className="mr-1 size-3" /> Passwords match
                        </span>
                      ) : (
                        <span className="text-destructive">Passwords do not match</span>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex items-start gap-2 pt-1 text-xs">
                  <input
                    id="terms"
                    type="checkbox"
                    className="mt-0.5 size-4 rounded border-gray-300"
                    checked={agreeTerms}
                    onChange={(e) => setAgreeTerms(e.target.checked)}
                  />
                  <label htmlFor="terms" className="text-muted-foreground">
                    I agree to the OrbitPay Terms of Service and Privacy Policy.
                  </label>
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={busy || !email || !passwordValid || !passwordsMatch || !agreeTerms}
                >
                  {busy ? "Creating account..." : "Create Account"}
                  {!busy && <ArrowRight className="ml-2 size-4" />}
                </Button>
              </form>
            </CardContent>

            <CardFooter className="flex flex-col space-y-2 border-t pt-4 text-center text-xs text-muted-foreground">
              <div>
                Already have an account?{" "}
                <Link href="/login" className="font-semibold text-primary hover:underline">
                  Sign in
                </Link>
              </div>
            </CardFooter>
          </>
        )}
      </Card>
    </div>
  );
}

