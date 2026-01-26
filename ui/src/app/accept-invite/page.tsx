"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { organization, useSession, getSession } from "@/lib/auth-client";
import { apiClient } from "@/lib/hono-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Mail, UserPlus, CheckCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type InvitationDetails = {
  id: string;
  email: string;
  role: string | string[];
  organizationId: string;
  organization?: { name: string } | null;
  inviter?: { user?: { name?: string; email?: string } | null } | null;
  expiresAt: Date | string;
  status: string;
};

function AcceptInviteContent() {
  const search = useSearchParams();
  const invitationId = search.get("invitationId") ?? "";
  const { data: session, isPending } = useSession();
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [loadingInvite, setLoadingInvite] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const router = useRouter();
  const hasCurrentOrg = Boolean(session?.organization?.id);
  const [emailMismatch, setEmailMismatch] = useState<string | null>(null);
  const [precheck, setPrecheck] = useState<{
    canMove: boolean;
    reasons: string[];
    otherMembersCount: number;
    otherOwnersCount: number;
    activeSubscriptionsCount: number;
  } | null>(null);

  useEffect(() => {
    const fetchInvitation = async () => {
      if (!invitationId) {
        setLoadingInvite(false);
        return;
      }

      // If not authenticated, redirect to login with invitation context
      if (!isPending && !session?.user) {
        setLoadingInvite(false);
        const returnTo = `/accept-invite?invitationId=${encodeURIComponent(invitationId)}`;
        router.push(
          `/login?returnTo=${encodeURIComponent(returnTo)}&invitationId=${encodeURIComponent(invitationId)}`
        );
        return;
      }

      if (isPending) return;

      try {
        const result = await organization.getInvitation({
          query: { id: invitationId },
        });
        if (result.data) {
          setInvitation(result.data as InvitationDetails);
        } else if (result.error) {
          if (!session?.user) {
            toast.error("Please sign in to view invitation");
          } else {
            toast.error("Invalid or expired invitation");
          }
        }
        // Fetch public invitation info to enrich with org name when missing
        try {
          const API_URL = process.env.NEXT_PUBLIC_API_URL;
          const res = await fetch(
            `${API_URL}/v1/public/invitation/${invitationId}`,
            { credentials: "include" }
          );
          if (res.ok) {
            const data = (await res.json()) as {
              organizationName?: string;
              role?: string;
              inviterName?: string;
              email?: string;
            };
            setInvitation((prev) => {
              const base = (prev || {
                id: invitationId,
                email: data.email || "",
                role: data.role || "member",
                organizationId: "",
                expiresAt: "",
                status: "pending",
              }) as InvitationDetails;
              return {
                ...base,
                email: data.email || base.email,
                role: data.role || base.role,
                organization: {
                  name: data.organizationName || base.organization?.name || "",
                },
              } as InvitationDetails;
            });
          }
        } catch {}
      } catch {
        toast.error("Failed to load invitation details");
      } finally {
        setLoadingInvite(false);
      }
    };
    fetchInvitation();
  }, [invitationId, isPending, session?.user, router]);

  useEffect(() => {
    if (!invitationId || isPending || loadingInvite || !invitation) return;

    const sessionEmail = session?.user?.email?.toLowerCase() || null;
    const invitationEmail = invitation.email?.toLowerCase() || null;

    if (sessionEmail && invitationEmail && sessionEmail !== invitationEmail) {
      if (!emailMismatch) {
        toast.error(
          `This invitation is for ${invitation.email}. Please sign in with that account.`
        );
      }
      setEmailMismatch(invitation.email || invitationEmail);
      setPrecheck(null);
      return;
    }

    if (emailMismatch) {
      setEmailMismatch(null);
    }

    if (!hasCurrentOrg) {
      setPrecheck(null);
      return;
    }

    if (session?.user) {
      (async () => {
        try {
          const res =
            await apiClient.team["accept-invitation"]["precheck"].$get();
          if (res.ok) {
            const data = (await res.json()) as NonNullable<typeof precheck>;
            setPrecheck(data);
          } else {
            setPrecheck(null);
          }
        } catch {
          setPrecheck(null);
        }
      })();
    }
  }, [
    invitationId,
    isPending,
    loadingInvite,
    session,
    invitation,
    hasCurrentOrg,
    emailMismatch,
  ]);

  const handleSignIn = () => {
    const returnTo = `/accept-invite?invitationId=${encodeURIComponent(invitationId)}`;
    router.push(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  };

  const handleJoinOrganization = async () => {
    if (!invitationId || emailMismatch) return;
    setAccepting(true);
    try {
      const res = await apiClient.team["accept-invitation"].$post({
        json: { invitationId },
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        toast.error(data?.error || "Failed to join organization");
        setAccepting(false);
        return;
      }
      try {
        await getSession({ query: { disableCookieCache: true } });
      } catch {}
      setAccepted(true);
      toast.success("Successfully joined the organization!");
      setTimeout(() => {
        if (typeof window !== "undefined") {
          window.location.replace("/dashboard");
        } else {
          router.replace("/dashboard");
        }
      }, 1200);
    } catch {
      toast.error("Failed to join organization");
      setAccepting(false);
    }
  };

  const roleDisplay = (role: string | string[]) => {
    const roles = Array.isArray(role) ? role : [role];
    return roles.map((r) => r.charAt(0).toUpperCase() + r.slice(1)).join(", ");
  };

  if (loadingInvite) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="w-[480px]">
          <CardContent className="pt-6">
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!invitationId || !invitation) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="w-[480px]">
          <CardHeader>
            <CardTitle>Invalid Invitation</CardTitle>
            <CardDescription>
              This invitation link is invalid or has expired.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push("/login")} className="w-full">
              Go to Login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="w-[480px]">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <CardTitle>Success!</CardTitle>
                <CardDescription>
                  You&apos;ve joined {invitation.organization?.name}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Redirecting to dashboard...
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (accepting) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="w-[480px]">
          <CardHeader>
            <CardTitle>Joining Organization...</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4">
        <Card className="w-full max-w-[520px]">
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center">
                <UserPlus className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <CardTitle>Team Invitation</CardTitle>
                <CardDescription>
                  You&apos;ve been invited to join an organization
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {search.get("invitee") && (
              <div className="bg-blue-50 text-blue-800 text-xs rounded-md p-3 border border-blue-200">
                You must sign in with{" "}
                <span className="font-semibold">{search.get("invitee")}</span>{" "}
                to accept this invitation.
              </div>
            )}
            <div className="bg-muted/50 rounded-lg p-4 space-y-3">
              <div className="flex items-start gap-3">
                <Mail className="h-5 w-5 text-muted-foreground mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">Organization</p>
                  <p className="text-base font-semibold">
                    {invitation.organization?.name || "Unknown"}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <UserPlus className="h-5 w-5 text-muted-foreground mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">Your Role</p>
                  <Badge variant="secondary">
                    {roleDisplay(invitation.role)}
                  </Badge>
                </div>
              </div>
              {invitation.inviter?.user && (
                <div className="flex items-start gap-3">
                  <Mail className="h-5 w-5 text-muted-foreground mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Invited by</p>
                    <p className="text-sm">
                      {invitation.inviter.user.name ||
                        invitation.inviter.user.email}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                To accept this invitation, please sign in with{" "}
                <span className="font-semibold">{invitation.email}</span>. If
                you don&apos;t have an account, one will be created for you.
              </p>

              <Button onClick={handleSignIn} className="w-full" size="lg">
                Continue to Sign In
              </Button>

              <p className="text-xs text-center text-muted-foreground">
                By continuing, you&apos;ll be able to access and manage this
                organization&apos;s billing and subscriptions.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (emailMismatch) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4">
        <Card className="w-full max-w-[420px] text-center space-y-4">
          <CardHeader className="space-y-3">
            <CardTitle>Invite for a Different Account</CardTitle>
            <CardDescription>
              You&apos;re signed in as {session.user.email}, but this invitation
              is for {emailMismatch}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => router.replace("/dashboard")}
            >
              Back to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Simplified flow for users without an existing organization (brand-new accounts)
  if (!hasCurrentOrg) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4">
        <Card className="w-full max-w-[520px]">
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center">
                <UserPlus className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <CardTitle>Join {invitation.organization?.name}</CardTitle>
                <CardDescription>
                  Finish setting up your account by joining this organization.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="bg-blue-50 rounded-lg border border-blue-200 p-4 space-y-2">
              <p className="text-sm font-medium text-blue-900">
                Invited Organization
              </p>
              <p className="text-base font-semibold text-blue-900">
                {invitation.organization?.name || "Unknown"}
              </p>
              <div className="text-sm text-blue-800">
                Your role after joining:{" "}
                <span className="font-semibold">
                  {roleDisplay(invitation.role)}
                </span>
              </div>
            </div>
            {invitation.inviter?.user ? (
              <div className="text-sm text-muted-foreground">
                Invitation sent by{" "}
                <span className="font-semibold">
                  {invitation.inviter.user.name ||
                    invitation.inviter.user.email}
                </span>
                .
              </div>
            ) : null}
            <div className="text-sm bg-muted/50 border border-muted-foreground/10 rounded-md p-3 text-muted-foreground">
              A new organization will be added to your account. You can start
              using Lumen with your team right away.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Button
                variant="outline"
                onClick={() => router.replace("/dashboard")}
              >
                Cancel
              </Button>
              <Button onClick={handleJoinOrganization} disabled={accepting}>
                {accepting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Join Organization"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Logged-in flow with an existing organization: show explicit confirmation before moving
  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <Card className="w-full max-w-[640px]">
        <CardHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center">
              <UserPlus className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <CardTitle>Confirm Organization Change</CardTitle>
              <CardDescription>
                You are currently a member of {session.organization?.name}.
                Joining {invitation.organization?.name} will move your account.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-muted/50 rounded-lg p-4 space-y-2">
              <p className="text-sm font-medium">Current Organization</p>
              <p className="text-base font-semibold">
                {session.organization?.name}
              </p>
              <div className="text-sm text-muted-foreground">
                Merchant:{" "}
                {session.merchant?.displayName ||
                  session.merchant?.legalName ||
                  "Unknown"}
              </div>
              <div className="text-xs text-muted-foreground">
                Your role: {session.memberRole}
              </div>
            </div>
            <div className="bg-blue-50 rounded-lg p-4 space-y-2 border border-blue-200">
              <p className="text-sm font-medium text-blue-900">
                Invited Organization
              </p>
              <p className="text-base font-semibold text-blue-900">
                {invitation.organization?.name || "Unknown"}
              </p>
              <div className="text-sm text-blue-800">
                Your role after joining:{" "}
                <span className="font-semibold">
                  {roleDisplay(invitation.role)}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="text-sm bg-amber-50 text-amber-900 border border-amber-200 rounded-md p-3">
              By joining{" "}
              <span className="font-semibold">
                {invitation.organization?.name || "Unknown"}
              </span>
              , you will leave{" "}
              <span className="font-semibold">
                {session.organization?.name}
              </span>
              . Your previous organization and merchant will be deleted. This
              action cannot be undone.
              {precheck?.reasons?.length ? (
                <ul className="list-disc pl-5 mt-2 space-y-1">
                  {precheck.reasons.map((r, i) => (
                    <li key={i} className="text-sm">
                      {r}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Button
                variant="outline"
                onClick={() => router.replace("/dashboard")}
              >
                Cancel
              </Button>
              <Button
                onClick={handleJoinOrganization}
                disabled={accepting || precheck?.canMove === false}
              >
                {accepting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Join Organization"
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AcceptInvitePage() {
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
      <AcceptInviteContent />
    </Suspense>
  );
}
