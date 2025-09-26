"use client";
/*

This page is a copy of login/page.tsx, with small variations in the copy.
It redirects to create-demo-data/page.tsx after login which creates demo merchant, plans, customers, and subscriptions.

*/
const REDIRECT_AFTER_LOGIN = "/create-demo-data";

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
import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { signIn, signUp, authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

export default function Demo() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [isCommandPressed, setIsCommandPressed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isResetMode, setIsResetMode] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const { data: session, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isPending && session?.user) {
      router.replace(REDIRECT_AFTER_LOGIN);
    }
  }, [session, isPending, router]);

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
        callbackURL: window.location.origin + REDIRECT_AFTER_LOGIN,
      });

      if (signUpResponse.error) {
        setError(`Failed to create mock user: ${signUpResponse.error.message}`);
      } else {
        // Try to sign in after signup (will work if email verification is disabled)
        try {
          await signIn.email({
            email: randomEmail,
            password: randomPassword,
            callbackURL: window.location.origin + REDIRECT_AFTER_LOGIN,
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
        <CardHeader>
          <CardTitle className="text-lg md:text-xl">Interactive Demo</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Continue with your details to experience a consistent demo
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

                <Button type="submit" className="w-full" disabled={loading}>
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
                    callbackURL: window.location.origin + REDIRECT_AFTER_LOGIN,
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
                        setSuccess("Attempting to create account...");

                        const signUpResponse = await signUp.email({
                          email,
                          password,
                          name: email,
                          callbackURL:
                            window.location.origin + REDIRECT_AFTER_LOGIN,
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
                    router.replace(REDIRECT_AFTER_LOGIN); // Explicit redirect on success
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
                      setEmail(e.target.value);
                    }}
                    value={email}
                  />
                </div>

                <div className="grid gap-2">
                  <div className="flex items-center">
                    <Label htmlFor="password">Password</Label>
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

                {isCommandPressed && (
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

                <Button type="submit" className="w-full" disabled={loading}>
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
                          window.location.origin + REDIRECT_AFTER_LOGIN,
                      });
                    }}
                    disabled={googleLoading}
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
                    Continue with Google
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
