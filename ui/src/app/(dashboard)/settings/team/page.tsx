"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { apiClient } from "@/lib/hono-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import {
  UserPlus,
  Mail,
  Shield,
  User,
  Crown,
  Clock,
  Trash2,
  Copy,
} from "lucide-react";

type Role = "owner" | "admin" | "member" | "developer";

type OrgMember = {
  id: string;
  userId: string;
  role: string | string[];
  user?: { email?: string | null } | null;
};

type OrgInvitation = {
  id: string;
  email: string;
  role: string | string[];
};

export default function TeamSettingsPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("developer");
  const orgId = session?.organization?.id;
  const myRole = session?.memberRole ?? "member";
  const myRoles = useMemo(() => (myRole || "").split(","), [myRole]);
  const isOwner = myRoles.includes("owner");

  const canInviteAdminOrOwner = isOwner;
  const canManage = isOwner;

  const ownersCount = useMemo(() => {
    return members.filter((m) => {
      const r = m.role;
      const roles = Array.isArray(r)
        ? r
        : typeof r === "string"
          ? r.split(",")
          : [];
      return roles.includes("owner");
    }).length;
  }, [members]);

  const refetch = React.useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await apiClient.team.members.$get();
      if (res.ok) {
        const data = await res.json();
        const arr = Array.isArray(data) ? (data as OrgMember[]) : [];
        setMembers(arr);
      } else {
        setMembers([]);
      }
    } catch {
      setMembers([]);
    }
    try {
      const res = await apiClient.team.invitations.$get();
      if (res.ok) {
        const data = await res.json();
        const arr = Array.isArray(data) ? (data as OrgInvitation[]) : [];
        setInvitations(arr);
      } else {
        setInvitations([]);
      }
    } catch {
      setInvitations([]);
    }
  }, [orgId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (session && !isOwner) {
      toast.error("Only organization owners can access team settings");
      router.replace("/dashboard");
    }
  }, [isOwner, session, router]);

  if (!isOwner && session) {
    return null;
  }

  const handleInvite = async () => {
    if (!email) return;
    try {
      if ((role === "admin" || role === "owner") && !canInviteAdminOrOwner) {
        toast.error("Only owner can invite admins/owners");
        return;
      }
      if (!(role === "developer" || role === "owner")) {
        toast.error("Only Owner and Developer roles are allowed");
        return;
      }
      const res = await apiClient.team.members.invite.$post({
        json: { email, role },
      });
      let data: { message?: string; error?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.status === 409) {
        toast.info(
          data?.message ||
            "This user is already a member or has a pending invitation."
        );
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || data?.message || "Invite failed");
      }

      toast.success(data?.message || "Invitation sent");
      setEmail("");
      setRole("developer");
      refetch();
    } catch (error) {
      if (error instanceof Error) {
        toast.error(error.message);
      } else {
        toast.error("Failed to send invite");
      }
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    try {
      const res = await apiClient.team.invitations[":invitationId"].$delete({
        param: { invitationId },
      });
      if (!res.ok) throw new Error("Cancel failed");
      toast.success("Invitation canceled");
      refetch();
    } catch {
      toast.error("Failed to cancel invitation");
    }
  };

  const handleCopyInviteLink = async (invitation: OrgInvitation) => {
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : process.env.NEXT_PUBLIC_APP_URL || "";
    if (!origin) {
      toast.error("Unable to determine invite URL");
      return;
    }
    const inviteLink = `${origin}/accept-invite?invitationId=${encodeURIComponent(invitation.id)}&invitee=${encodeURIComponent(invitation.email)}`;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteLink);
        toast.success("Invite link copied to clipboard", {
          description: inviteLink,
        });
        return;
      }
      throw new Error("Clipboard API unavailable");
    } catch {
      toast.info("Invite link ready", {
        description: inviteLink,
      });
    }
  };

  const handleRemoveMember = async (memberId: string, targetRole: string) => {
    try {
      const targetIsElevated =
        targetRole.includes("admin") || targetRole.includes("owner");
      const isSelf =
        members.find((m) => m.id === memberId)?.userId === session?.user?.id;
      if (isSelf) {
        toast.error("You cannot remove yourself from the organization");
        return;
      }
      if (targetIsElevated && !isOwner) {
        toast.error("Only owner can remove admins/owners");
        return;
      }
      if (!canManage) {
        toast.error("Forbidden");
        return;
      }
      const targetDisplay =
        members.find((m) => m.id === memberId)?.user?.email || "this user";
      const confirmed = window.confirm(
        `This will permanently delete ${targetDisplay}'s account and remove all access. This action cannot be undone.\n\nAre you sure you want to proceed?`
      );
      if (!confirmed) return;
      const res = await apiClient.team.members[":memberId"].$delete({
        param: { memberId },
      });
      if (!res.ok) throw new Error("Remove failed");
      toast.success("User account deleted");
      refetch();
    } catch {
      toast.error("Failed to delete user");
    }
  };

  const handleChangeRole = async (memberId: string, newRole: Role) => {
    try {
      const target = members.find((m) => m.id === memberId);
      const targetRoleValue = target?.role as string | string[] | undefined;
      const targetRoles = Array.isArray(targetRoleValue)
        ? targetRoleValue
        : typeof targetRoleValue === "string"
          ? targetRoleValue.split(",")
          : ["member"];
      const targetIsOwner = targetRoles.includes("owner");
      const ownersCount = members.filter((m) => {
        const r = m.role;
        const roles = Array.isArray(r)
          ? r
          : typeof r === "string"
            ? r.split(",")
            : [];
        return roles.includes("owner");
      }).length;
      const isSelf = target?.userId === session?.user?.id;

      if ((newRole === "admin" || newRole === "owner") && !isOwner) {
        toast.error("Only owner can set admin/owner roles");
        return;
      }
      if (!canManage) {
        toast.error("Forbidden");
        return;
      }
      if (targetIsOwner && newRole !== "owner" && ownersCount <= 1) {
        toast.error("Cannot remove the last organization owner");
        return;
      }
      if (isSelf && targetIsOwner && newRole !== "owner" && ownersCount <= 1) {
        toast.error("You are the last owner and cannot demote yourself");
        return;
      }
      const res = await apiClient.team.members.role.$put({
        json: { memberId, role: newRole },
      });
      if (!res.ok) throw new Error("Update role failed");
      toast.success("Role updated");
      refetch();
    } catch {
      toast.error("Failed to update role");
    }
  };

  const getRoleBadgeVariant = (role: string) => {
    switch (role.toLowerCase()) {
      case "owner":
        return "default";
      case "admin":
        return "secondary";
      case "developer":
        return "outline";
      case "member":
        return "outline";
      default:
        return "outline";
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role.toLowerCase()) {
      case "owner":
        return <Crown className="h-3.5 w-3.5" />;
      case "admin":
        return <Shield className="h-3.5 w-3.5" />;
      case "developer":
        return <User className="h-3.5 w-3.5" />;
      case "member":
        return <User className="h-3.5 w-3.5" />;
      default:
        return <User className="h-3.5 w-3.5" />;
    }
  };

  const getInitials = (email: string) => {
    const parts = email.split("@")[0].split(/[._-]/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return email.substring(0, 2).toUpperCase();
  };

  return (
    <div className="space-y-6">
      {canManage && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle>Invite Team Member</CardTitle>
                <CardDescription>
                  Add new members to your organization
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <div className="flex-1">
                <Input
                  placeholder="Enter email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleInvite();
                    }
                  }}
                />
              </div>
              <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="developer">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4" />
                      Developer
                    </div>
                  </SelectItem>
                  <SelectItem value="owner" disabled={!canInviteAdminOrOwner}>
                    <div className="flex items-center gap-2">
                      <Crown className="h-4 w-4" />
                      Owner
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={handleInvite} disabled={!canManage || !email}>
                Send Invite
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Team Members</CardTitle>
              <CardDescription>
                Manage access and permissions for your team
              </CardDescription>
            </div>
            <Badge variant="secondary" className="text-sm">
              {members.length} {members.length === 1 ? "member" : "members"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {members?.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <User className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <p className="text-sm text-muted-foreground">No members yet.</p>
            </div>
          )}
          <div className="space-y-1">
            {members?.map((m) => {
              const memberRole = Array.isArray(m.role)
                ? m.role[0]
                : (m.role as string);
              const email = m.user?.email ?? m.userId;
              const isSelf = m.userId === session?.user?.id;

              return (
                <div
                  key={m.id}
                  className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Avatar className="h-10 w-10 border">
                      <AvatarFallback className="text-xs font-medium">
                        {getInitials(email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{email}</p>
                        {isSelf && (
                          <Badge variant="outline" className="text-xs">
                            You
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Badge
                          variant={getRoleBadgeVariant(memberRole)}
                          className="text-xs gap-1"
                        >
                          {getRoleIcon(memberRole)}
                          {memberRole.charAt(0).toUpperCase() +
                            memberRole.slice(1)}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-2 ml-4">
                      <Select
                        value={memberRole as Role}
                        onValueChange={(v) => handleChangeRole(m.id, v as Role)}
                      >
                        <SelectTrigger className="w-[140px] h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="developer">Developer</SelectItem>
                          <SelectItem value="member">Member</SelectItem>
                          <SelectItem value="admin" disabled={!isOwner}>
                            Admin
                          </SelectItem>
                          <SelectItem value="owner" disabled={!isOwner}>
                            Owner
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                        disabled={
                          isSelf ||
                          ((Array.isArray(m.role)
                            ? m.role
                            : typeof m.role === "string"
                              ? m.role.split(",")
                              : []
                          ).includes("owner") &&
                            (!isOwner || ownersCount <= 1))
                        }
                        onClick={() =>
                          handleRemoveMember(
                            m.id,
                            Array.isArray(m.role) ? m.role.join(",") : m.role
                          )
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Pending Invitations</CardTitle>
              <CardDescription>
                Invitations waiting to be accepted
              </CardDescription>
            </div>
            {invitations.length > 0 && (
              <Badge variant="secondary" className="text-sm">
                {invitations.length}{" "}
                {invitations.length === 1 ? "pending" : "pending"}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {invitations?.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Clock className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <p className="text-sm text-muted-foreground">
                No pending invitations.
              </p>
            </div>
          )}
          <div className="space-y-1">
            {invitations?.map((inv) => {
              const invRole = Array.isArray(inv.role)
                ? inv.role[0]
                : (inv.role as string);

              return (
                <div
                  key={inv.id}
                  className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Avatar className="h-10 w-10 border border-dashed">
                      <AvatarFallback className="text-xs font-medium bg-muted">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {inv.email}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Badge
                          variant={getRoleBadgeVariant(invRole)}
                          className="text-xs gap-1"
                        >
                          {getRoleIcon(invRole)}
                          {invRole.charAt(0).toUpperCase() + invRole.slice(1)}
                        </Badge>
                        <Badge variant="outline" className="text-xs gap-1">
                          <Clock className="h-3 w-3" />
                          Pending
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="gap-2"
                      onClick={() => handleCopyInviteLink(inv)}
                      disabled={!canManage}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy Link
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCancelInvitation(inv.id)}
                      disabled={!canManage}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
