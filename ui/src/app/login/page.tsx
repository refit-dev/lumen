"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState, useEffect, useMemo, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { signIn, signUp, authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/auth-client";
import { useRouter, useSearchParams } from "next/navigation";
import { Turnstile } from "@marsidev/react-turnstile";
import { TURNSTILE_SITE_KEY } from "@/lib/utils";

function LoginContent() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [isCommandPressed, setIsCommandPressed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isResetMode, setIsResetMode] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const invitationId = useMemo(() => {
    const fromTopLevel = searchParams.get("invitationId");
    if (fromTopLevel) return fromTopLevel;
    const rawReturnTo = searchParams.get("returnTo");
    if (!rawReturnTo) return null;
    try {
      const base =
        typeof window !== "undefined"
          ? window.location.origin
          : "http://localhost";
      const url = new URL(rawReturnTo, base);
      return url.searchParams.get("invitationId");
    } catch {
      return null;
    }
  }, [searchParams]);
  type InvitationBanner = {
    organizationName?: string;
    role?: string;
    inviterName?: string;
    email?: string;
  } | null;
  const [invitationDetails, setInvitationDetails] =
    useState<InvitationBanner>(null);

  const returnTo = useMemo(() => {
    const raw = searchParams.get("returnTo");
    if (!raw) return null;

    // Allow relative internal paths starting with '/'
    if (raw.startsWith("/")) {
      return raw;
    }

    // In browser, validate absolute URLs are same-origin
    if (typeof window !== "undefined") {
      try {
        const url = new URL(raw, window.location.origin);
        if (url.origin === window.location.origin) {
          return url.pathname + url.search;
        }
      } catch {
        return null;
      }
    }

    return null;
  }, [searchParams]);

  // Prefill the email from invite link immediately to avoid flicker
  useEffect(() => {
    const fromQuery = searchParams.get("invitee");
    if (fromQuery && fromQuery !== email) {
      setEmail(fromQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    const fetchInvitationInfo = async () => {
      if (!invitationId) return;
      try {
        // Hono client types may not include this route signature yet; fall back to fetch
        const API_URL = process.env.NEXT_PUBLIC_API_URL;
        const res = await fetch(
          `${API_URL}/v1/public/invitation/${invitationId}`,
          {
            credentials: "include",
          }
        );
        if (res.ok) {
          const data = (await res.json()) as {
            organizationName?: string;
            role?: string;
            inviterName?: string;
            email?: string;
          };
          setInvitationDetails({
            organizationName: data.organizationName,
            role: data.role,
            inviterName: data.inviterName,
            email: data.email,
          });
          // If server returned email, set it
          if (data.email) {
            setEmail(data.email);
          }
        }
      } catch {
        // Silently fail - invitation context is optional
      }
    };
    fetchInvitationInfo();
  }, [invitationId]);

  useEffect(() => {
    if (!isPending && session?.user) {
      router.replace(returnTo || "/dashboard");
    }
  }, [session, isPending, router, returnTo]);

  // UseEffect for generate mock user. Hold Cmd/Ctrol key to render the mock button in the login page
  useEffect(() => {
    const isAllowedDomain =
      window.location.hostname.includes("localhost") ||
      window.location.hostname.includes("staging");

    if (!isAllowedDomain) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) {
        setIsCommandPressed(true);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) {
        setIsCommandPressed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authClient.forgetPassword({
        email: resetEmail,
        redirectTo: window.location.origin + "/reset-password",
        fetchOptions: {
          headers: {
            "x-captcha-response": turnstileToken,
          },
        },
      });

      if (response.error) {
        setError(`Password reset failed: ${response.error.message}`);
      } else {
        setSuccess(
          "Password reset email sent! Please check your inbox for the reset link."
        );
      }
    } catch (error) {
      console.error("Password reset error:", error);
      setError("Failed to send password reset email. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleRandomUser = async () => {
    const timestamp = Date.now();
    const randomEmail = `${timestamp}@getlumen.dev`;
    const randomPassword = `password${timestamp}`;

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const signUpResponse = await signUp.email({
        email: randomEmail,
        password: randomPassword,
        name: randomEmail,
        callbackURL: window.location.origin + "/onboarding",
        fetchOptions: {
          headers: {
            "x-captcha-response": turnstileToken,
          },
        },
      });

      if (signUpResponse.error) {
        setError(`Failed to create mock user: ${signUpResponse.error.message}`);
      } else {
        // Try to sign in after signup (will work if email verification is disabled)
        try {
          await signIn.email({
            email: randomEmail,
            password: randomPassword,
            callbackURL: window.location.origin + "/onboarding",
            fetchOptions: {
              headers: {
                "x-captcha-response": turnstileToken,
              },
            },
          });
          setSuccess("Mock user created and signed in!");
        } catch (signInError) {
          // If sign in fails (likely due to email verification), just show success message
          console.log(
            "Sign in failed after signup (likely due to email verification):",
            signInError
          );
          setSuccess(
            "Mock user created! Check console for verification link if email verification is enabled."
          );
        }
      }
    } catch (error) {
      console.error("Mock user creation error:", error);
      setError("Failed to create mock user. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (isPending || session?.user) {
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        {invitationDetails && (
          <div className="bg-blue-50 border-b border-blue-200 p-4">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5 text-blue-600"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path d="M8 9a3 3 0 100-6 3 3 0 000 6zM8 11a6 6 0 016 6H2a6 6 0 016-6zM16 7a1 1 0 10-2 0v1h-1a1 1 0 100 2h1v1a1 1 0 102 0v-1h1a1 1 0 100-2h-1V7z" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-blue-900 mb-1">
                  Team Invitation
                </p>
                <p className="text-sm text-blue-800">
                  You&apos;ve been invited to join{" "}
                  <span className="font-bold">
                    {invitationDetails.organizationName}
                  </span>{" "}
                  as a{" "}
                  <span className="font-bold">{invitationDetails.role}</span>
                  {invitationDetails.inviterName && (
                    <>
                      {" "}
                      by{" "}
                      <span className="font-semibold">
                        {invitationDetails.inviterName}
                      </span>
                    </>
                  )}
                </p>
              </div>
            </div>
          </div>
        )}
        <CardHeader>
          <CardTitle className="text-lg md:text-xl">
            {invitationDetails ? "Sign in to Continue" : "Welcome"}
          </CardTitle>
          <CardDescription className="text-xs md:text-sm">
            {invitationDetails
              ? "Sign in or create an account to accept the invitation"
              : "Sign in to your account or create a new one"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isResetMode ? (
            // Password Reset Form
            <form onSubmit={handlePasswordReset}>
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="reset-email">Email</Label>
                  <Input
                    id="reset-email"
                    type="email"
                    placeholder="Enter your email address"
                    required
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                  />
                </div>

                {error && (
                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded-md">
                    {error}
                  </div>
                )}

                {success && (
                  <div className="text-sm text-green-600 bg-green-50 p-3 rounded-md">
                    {success}
                  </div>
                )}

                <Turnstile
                  siteKey={TURNSTILE_SITE_KEY}
                  onSuccess={setTurnstileToken}
                  onExpire={() => setTurnstileToken("")}
                />

                <Button
                  type="submit"
                  className="w-full"
                  disabled={loading || !turnstileToken}
                >
                  {loading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    "Send Reset Email"
                  )}
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setIsResetMode(false);
                    setError(null);
                    setSuccess(null);
                    setResetEmail("");
                  }}
                >
                  Back to Login
                </Button>
              </div>
            </form>
          ) : (
            // Normal Login Form
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setLoading(true);
                setError(null);
                setSuccess(null);

                try {
                  const signInResponse = await signIn.email({
                    email,
                    password,
                    callbackURL:
                      window.location.origin + (returnTo || "/dashboard"),
                    fetchOptions: {
                      headers: {
                        "x-captcha-response": turnstileToken,
                      },
                    },
                  });
                  console.log("signInResponse: ", signInResponse);

                  if (signInResponse.error) {
                    const signInError = signInResponse.error;

                    // Use error.code for proper error handling as recommended by Better Auth
                    switch (signInError.code) {
                      case "EMAIL_NOT_VERIFIED":
                        setError(
                          "Please verify your email address. Check your inbox (and spam folder) for a verification link."
                        );
                        break;

                      case "INVALID_EMAIL_OR_PASSWORD":
                        // Could be either user doesn't exist OR wrong password
                        // Try signing up to provide unified UX
                        setSuccess("Creating account...");

                        const signUpResponse = await signUp.email({
                          email,
                          password,
                          name: email,
                          callbackURL:
                            window.location.origin +
                            (returnTo || "/onboarding"),
                          fetchOptions: {
                            headers: {
                              "x-captcha-response": turnstileToken,
                            },
                          },
                        });

                        if (signUpResponse.error) {
                          const signUpError = signUpResponse.error;
                          switch (signUpError.code) {
                            case "USER_ALREADY_EXISTS":
                              // User exists, so the original sign-in failed due to wrong password
                              setError(
                                "Invalid password. Please check your password and try again."
                              );
                              setSuccess(null);
                              break;
                            case "EMAIL_NOT_VERIFIED":
                              setSuccess(
                                "Account created! Please check your email (and spam folder) for a verification link."
                              );
                              break;
                            default:
                              setError(
                                `Authentication failed: ${signUpError.message || "Please try again."}`
                              );
                              setSuccess(null);
                              break;
                          }
                        } else {
                          // Signup succeeded - user should be automatically signed in unless email verification is required
                          setSuccess(
                            "Account created successfully! Please check your email for a verification link."
                          );
                        }
                        break;

                      default:
                        setError(
                          `Sign in failed: ${signInError.message || "An unknown error occurred."}`
                        );
                        break;
                    }
                  } else {
                    // Sign in successful
                    setSuccess("Signed in successfully! Redirecting...");
                    router.replace(returnTo || "/dashboard");
                  }
                } catch (e: unknown) {
                  console.error("Authentication process error:", e);
                  if (e instanceof Error) {
                    setError(`An unexpected error occurred: ${e.message}`);
                  } else {
                    setError("An unexpected error occurred. Please try again.");
                  }
                } finally {
                  setLoading(false);
                }
              }}
            >
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="m@example.com"
                    required
                    onChange={(e) => {
                      if (!invitationDetails) setEmail(e.target.value);
                    }}
                    value={
                      invitationDetails?.email ||
                      searchParams.get("invitee") ||
                      email
                    }
                    disabled={!!invitationDetails}
                    readOnly={!!invitationDetails}
                  />
                  {invitationDetails && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      You are accepting an invitation. Your account will be
                      created for
                      <span className="font-medium">
                        {" "}
                        {invitationDetails?.email ||
                          searchParams.get("invitee")}
                      </span>
                      .
                    </p>
                  )}
                </div>

                <div className="grid gap-2">
                  <div className="flex items-center">
                    <Label htmlFor="password">Password</Label>
                    <button
                      type="button"
                      onClick={() => setIsResetMode(!isResetMode)}
                      className="ml-auto inline-block text-sm underline hover:text-primary cursor-pointer"
                    >
                      Forgot your password?
                    </button>
                  </div>

                  <Input
                    id="password"
                    type="password"
                    placeholder="password"
                    autoComplete="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                {/* Error and Success Messages */}
                {error && (
                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded-md">
                    {error}
                  </div>
                )}

                {success && (
                  <div className="text-sm text-green-600 bg-green-50 p-3 rounded-md">
                    {success}
                  </div>
                )}

                {isCommandPressed && !invitationDetails && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    onClick={handleRandomUser}
                    disabled={loading}
                  >
                    {loading ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      "Generate new mock user"
                    )}
                  </Button>
                )}

                <Turnstile
                  siteKey={TURNSTILE_SITE_KEY}
                  onSuccess={setTurnstileToken}
                  onExpire={() => setTurnstileToken("")}
                />

                <Button
                  type="submit"
                  className="w-full"
                  disabled={loading || !turnstileToken}
                >
                  {loading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    "Continue"
                  )}
                </Button>

                <div
                  className={cn(
                    "w-full gap-2 flex items-center",
                    "justify-between flex-col"
                  )}
                >
                  <Button
                    variant="outline"
                    className={cn("w-full gap-2")}
                    onClick={async () => {
                      setGoogleLoading(true);
                      await signIn.social({
                        provider: "google",
                        callbackURL:
                          window.location.origin + (returnTo || "/dashboard"),
                        fetchOptions: {
                          headers: {
                            "x-captcha-response": turnstileToken,
                          },
                        },
                      });
                    }}
                    disabled={googleLoading || !turnstileToken}
                  >
                    {googleLoading ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="0.98em"
                        height="1em"
                        viewBox="0 0 256 262"
                      >
                        <path
                          fill="#4285F4"
                          d="M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622l38.755 30.023l2.685.268c24.659-22.774 38.875-56.282 38.875-96.027"
                        ></path>
                        <path
                          fill="#34A853"
                          d="M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055c-34.523 0-63.824-22.773-74.269-54.25l-1.531.13l-40.298 31.187l-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1"
                        ></path>
                        <path
                          fill="#FBBC05"
                          d="M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82c0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602z"
                        ></path>
                        <path
                          fill="#EB4335"
                          d="M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0C79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251"
                        ></path>
                      </svg>
                    )}
                    Sign in with Google
                  </Button>
                </div>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function SignIn() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <Card className="w-[480px]">
            <CardContent className="pt-6">
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
