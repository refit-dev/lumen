import { Hono } from "hono";
import { requireAuth, requireOrgRole } from "../middleware/auth";
import { auth } from "../auth";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  invitation as invitationTable,
  organization as organizationTable,
  member as memberTable,
  merchants as merchantsTable,
  subscriptions as subscriptionsTable,
  user as userTable,
} from "@lumen/common/schema";

const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "developer"]).default("developer"),
});

const updateMemberRoleSchema = z.object({
  memberId: z.string(),
  role: z.enum(["owner", "admin", "member", "developer"]),
});

const removeMemberSchema = z.object({
  memberId: z.string(),
});

const cancelInvitationSchema = z.object({
  invitationId: z.string(),
});

export const teamRoute = new Hono()
  .get("/accept-invitation/precheck", requireAuth, async (c) => {
    try {
      const user = c.get("user");
      const org = c.get("organization");
      const merchant = c.get("merchant");
      if (!user || !org) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      // Fetch all members in current org
      const members = await db
        .select({ userId: memberTable.userId, role: memberTable.role })
        .from(memberTable)
        .where(eq(memberTable.organizationId, org.id));

      const otherMembers = members.filter((m) => m.userId !== user.id);
      const ownersCountOther = otherMembers.filter((m) =>
        (m.role || "").split(",").includes("owner")
      ).length;

      // Count active subscriptions on current merchant
      let activeSubscriptionsCount = 0;
      if (merchant?.id) {
        const result = await db
          .select({ count: sql<number>`count(*)` })
          .from(subscriptionsTable)
          .where(
            and(
              eq(subscriptionsTable.merchantId, merchant.id),
              isNull(subscriptionsTable.endTimestamp),
              isNull(subscriptionsTable.deletedAt),
              ne(subscriptionsTable.status, "canceled")
            )
          );
        activeSubscriptionsCount = Number(result?.[0]?.count || 0);
      }

      const hasOtherMembers = otherMembers.length > 0;
      const hasOtherOwner = ownersCountOther >= 1;
      const canMove = hasOtherMembers
        ? hasOtherOwner
        : activeSubscriptionsCount === 0;

      const reasons: string[] = [];
      if (!canMove) {
        if (!hasOtherMembers && activeSubscriptionsCount > 0) {
          reasons.push(
            `Your current organization has ${activeSubscriptionsCount} active subscription${activeSubscriptionsCount === 1 ? "" : "s"}. Cancel or move them before joining the new organization.`
          );
        }
        if (hasOtherMembers && !hasOtherOwner) {
          reasons.push(
            "At least one other member in your current organization must be an owner before you can leave."
          );
        }
      }

      return c.json({
        canMove,
        reasons,
        otherMembersCount: otherMembers.length,
        otherOwnersCount: ownersCountOther,
        activeSubscriptionsCount,
      });
    } catch (error) {
      console.error("Error during move precheck:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .post(
    "/accept-invitation",
    requireAuth,
    zValidator(
      "json",
      z.object({
        invitationId: z.string().min(1),
      })
    ),
    async (c) => {
      try {
        const { invitationId } = c.req.valid("json");
        const user = c.get("user");
        const currentOrg = c.get("organization");
        if (!user) {
          return c.json({ error: "Unauthorized" }, 401);
        }

        // Fetch invitation to determine target organization
        const inviteRows = await db
          .select({
            id: invitationTable.id,
            organizationId: invitationTable.organizationId,
            status: invitationTable.status,
          })
          .from(invitationTable)
          .where(eq(invitationTable.id, invitationId));
        const invite = inviteRows[0];

        if (!invite) {
          return c.json({ error: "Invitation not found" }, 404);
        }

        const targetOrgId = invite.organizationId;
        const currentOrgId = currentOrg?.id || null;

        if (currentOrgId && currentOrgId === targetOrgId) {
          return c.json(
            {
              success: true,
              moved: false,
              message: "Already a member of this organization",
            },
            200
          );
        }

        // Enforce move preconditions
        const members = currentOrgId
          ? await db
              .select({ userId: memberTable.userId, role: memberTable.role })
              .from(memberTable)
              .where(eq(memberTable.organizationId, currentOrgId))
          : [];
        const otherMembers = members.filter((m) => m.userId !== user.id);
        const ownersCountOther = otherMembers.filter((m) =>
          (m.role || "").split(",").includes("owner")
        ).length;

        if (currentOrgId) {
          const merchant = c.get("merchant");
          let activeSubscriptionsCount = 0;
          if (merchant?.id) {
            const result = await db
              .select({ count: sql<number>`count(*)` })
              .from(subscriptionsTable)
              .where(
                and(
                  eq(subscriptionsTable.merchantId, merchant.id),
                  isNull(subscriptionsTable.endTimestamp),
                  isNull(subscriptionsTable.deletedAt),
                  ne(subscriptionsTable.status, "canceled")
                )
              );
            activeSubscriptionsCount = Number(result?.[0]?.count || 0);
          }

          const hasOtherMembers = otherMembers.length > 0;
          const hasOtherOwner = ownersCountOther >= 1;
          if (!hasOtherMembers && activeSubscriptionsCount > 0) {
            return c.json(
              {
                error:
                  "You have active subscriptions on your current organization. Cancel or move them before joining the new organization.",
                code: "active_subscriptions",
                activeSubscriptionsCount,
              },
              400
            );
          }
          if (hasOtherMembers && !hasOtherOwner) {
            return c.json(
              {
                error:
                  "At least one other member must be an owner in your current organization before you can leave.",
                code: "no_other_owner",
              },
              400
            );
          }
        }

        // Accept invitation using Better Auth API with session headers
        await auth.api.acceptInvitation({
          body: { invitationId },
          headers: c.req.raw.headers,
        } as any);

        // Cleanup old organization and merchant if present
        if (currentOrgId) {
          await db.transaction(async (tx) => {
            // Determine if other members exist in the old organization
            const allMembers = await tx
              .select({ userId: memberTable.userId })
              .from(memberTable)
              .where(eq(memberTable.organizationId, currentOrgId));

            const otherMembers = allMembers.filter((m) => m.userId !== user.id);

            if (otherMembers.length <= 0) {
              // No other members remain: soft-delete merchant and delete org
              await tx
                .update(merchantsTable)
                .set({ deletedAt: new Date() })
                .where(
                  and(
                    eq(merchantsTable.organizationId, currentOrgId),
                    isNull(merchantsTable.deletedAt)
                  )
                );

              await tx
                .delete(organizationTable)
                .where(eq(organizationTable.id, currentOrgId));
            } else {
              // Other members remain: only remove the current user's membership
              await tx
                .delete(memberTable)
                .where(
                  and(
                    eq(memberTable.organizationId, currentOrgId),
                    eq(memberTable.userId, user.id)
                  )
                );
            }
          });
        }

        return c.json({ success: true, moved: true }, 200);
      } catch (error) {
        console.error("Error accepting invitation:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  .get("/members", requireAuth, requireOrgRole(["owner"]), async (c) => {
    try {
      const organizationId = c.get("organization")?.id;

      if (!organizationId) {
        return c.json({ error: "No organization found for this user" }, 404);
      }

      const members = await auth.api.listMembers({
        query: {
          organizationId,
        },
        headers: c.req.raw.headers,
      });
      // Normalize response shape and de-duplicate by userId
      const raw = Array.isArray(members) ? members : (members as any)?.members;
      const list = Array.isArray(raw) ? raw : [];
      const seen = new Set<string>();
      const deduped = list.filter((m: any) => {
        const key = m.userId || m.id;
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return c.json(deduped, 200);
    } catch (error) {
      console.error("Error fetching team members:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .post(
    "/members/invite",
    requireAuth,
    requireOrgRole(["owner"]),
    zValidator("json", inviteMemberSchema),
    async (c) => {
      try {
        const organizationId = c.get("organization")?.id;

        if (!organizationId) {
          return c.json({ error: "No organization found for this user" }, 404);
        }

        const { email, role } = c.req.valid("json");
        const trimmedEmail = email.trim();
        const normalizedEmail = trimmedEmail.toLowerCase();

        // Only owner can invite owners
        const currentRole = c.get("memberRole") || "member";
        const isOwner = (currentRole || "").split(",").includes("owner");
        if (role === "owner" && !isOwner) {
          return c.json(
            { error: "Only organization owner can invite owners" },
            403
          );
        }
        // Only allow Developer or Owner invites
        if (!(role === "developer" || role === "owner")) {
          return c.json(
            { error: "Only Owner and Developer roles are allowed" },
            400
          );
        }

        const existingMember = await db
          .select({ memberId: memberTable.id })
          .from(memberTable)
          .innerJoin(userTable, eq(memberTable.userId, userTable.id))
          .where(
            and(
              eq(memberTable.organizationId, organizationId),
              sql`lower(${userTable.email}) = ${normalizedEmail}`
            )
          )
          .limit(1);

        if (existingMember.length > 0) {
          return c.json(
            {
              error: "already_member",
              message: `${trimmedEmail} is already a member of this organization.`,
            },
            409
          );
        }

        const existingPendingInvite = await db
          .select({
            id: invitationTable.id,
            status: invitationTable.status,
          })
          .from(invitationTable)
          .where(
            and(
              eq(invitationTable.organizationId, organizationId),
              sql`lower(${invitationTable.email}) = ${normalizedEmail}`,
              eq(invitationTable.status, "pending")
            )
          )
          .limit(1);

        if (existingPendingInvite.length > 0) {
          return c.json(
            {
              error: "invite_already_exists",
              message: `An invitation has already been sent to ${trimmedEmail}.`,
              invitationId: existingPendingInvite[0].id,
            },
            409
          );
        }

        const result = await auth.api.createInvitation({
          body: {
            email: trimmedEmail,
            role: [role],
            organizationId,
          },
          headers: c.req.raw.headers,
        });

        if (!result) {
          return c.json({ error: "Failed to invite user" }, 500);
        }

        return c.json(
          { message: "Invitation sent successfully", invitation: result },
          201
        );
      } catch (error) {
        console.error("Error inviting team member:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  .put(
    "/members/role",
    requireAuth,
    requireOrgRole(["owner"]),
    zValidator("json", updateMemberRoleSchema),
    async (c) => {
      try {
        const organizationId = c.get("organization")?.id;

        if (!organizationId) {
          return c.json({ error: "No organization found for this user" }, 404);
        }

        const { memberId, role } = c.req.valid("json");

        const requesterRole = c.get("memberRole") || "member";
        const requesterRoles = (requesterRole || "").split(",");
        const requesterIsOwner = requesterRoles.includes("owner");
        const requesterIsAdmin = requesterRoles.includes("admin");

        // Fetch target member to inspect current roles
        const members = await auth.api.listMembers({
          query: {
            organizationId,
            limit: 1000,
          },
          headers: c.req.raw.headers,
        });
        const list = Array.isArray(members) ? members : (members as any);
        const target = Array.isArray(list)
          ? list.find((m: any) => m.id === memberId)
          : undefined;

        const targetRoleValue = target?.role as string | string[] | undefined;
        const targetRoles = Array.isArray(targetRoleValue)
          ? targetRoleValue
          : typeof targetRoleValue === "string"
            ? targetRoleValue.split(",")
            : ["member"];

        const targetIsAdminOrOwner = targetRoles.some((r) =>
          ["admin", "owner"].includes(r)
        );

        // Compute owner count and self member
        const ownersCount = (Array.isArray(list) ? list : []).filter(
          (m: any) => {
            const r = m.role;
            const roles = Array.isArray(r)
              ? r
              : typeof r === "string"
                ? r.split(",")
                : [];
            return roles.includes("owner");
          }
        ).length;
        const selfUserId = c.get("user")?.id;
        const selfMember = (Array.isArray(list) ? list : []).find(
          (m: any) => m.userId === selfUserId
        );
        const isSelfTarget = selfMember?.id === memberId;

        // Only owner can change roles of admins/owners OR assign admin/owner
        if (targetIsAdminOrOwner || role === "admin" || role === "owner") {
          if (!requesterIsOwner) {
            return c.json(
              { error: "Only organization owner can change admin/owner roles" },
              403
            );
          }
        } else {
          // For developer/member role changes, allow owner or admin
          if (!(requesterIsOwner || requesterIsAdmin)) {
            return c.json({ error: "Forbidden" }, 403);
          }
        }

        // Last-owner protection: cannot demote the last remaining owner
        const targetIsOwner = targetRoles.includes("owner");
        const newRoleRemovesOwner = role !== "owner";
        if (targetIsOwner && newRoleRemovesOwner && ownersCount <= 1) {
          return c.json(
            { error: "Cannot remove the last organization owner" },
            403
          );
        }

        // Self-protection: owner cannot demote themselves if they are the last owner
        if (
          isSelfTarget &&
          targetIsOwner &&
          newRoleRemovesOwner &&
          ownersCount <= 1
        ) {
          return c.json(
            { error: "You are the last owner and cannot demote yourself" },
            403
          );
        }

        await auth.api.updateMemberRole({
          body: {
            memberId,
            role: [role],
            organizationId,
          },
          headers: c.req.raw.headers,
        });

        return c.json({ message: "Member role updated successfully" }, 200);
      } catch (error) {
        console.error("Error updating member role:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  .delete(
    "/members/:memberId",
    requireAuth,
    requireOrgRole(["owner"]),
    async (c) => {
      try {
        const organizationId = c.get("organization")?.id;
        const memberId = c.req.param("memberId");

        if (!organizationId) {
          return c.json({ error: "No organization found for this user" }, 404);
        }

        const requesterRole = c.get("memberRole") || "member";
        const requesterRoles = (requesterRole || "").split(",");
        const requesterIsOwner = requesterRoles.includes("owner");
        const requesterIsAdmin = requesterRoles.includes("admin");

        // Fetch target member to inspect current roles
        const members = await auth.api.listMembers({
          query: {
            organizationId,
            limit: 1000,
          },
          headers: c.req.raw.headers,
        });
        const list = Array.isArray(members) ? members : (members as any);
        const target = Array.isArray(list)
          ? list.find((m: any) => m.id === memberId)
          : undefined;

        const targetRoleValue = target?.role as string | string[] | undefined;
        const targetRoles = Array.isArray(targetRoleValue)
          ? targetRoleValue
          : typeof targetRoleValue === "string"
            ? targetRoleValue.split(",")
            : ["member"];
        const targetIsAdminOrOwner = targetRoles.some((r) =>
          ["admin", "owner"].includes(r)
        );

        // Last-owner protection: cannot remove the last remaining owner
        const ownersCount = (Array.isArray(list) ? list : []).filter(
          (m: any) => {
            const r = m.role;
            const roles = Array.isArray(r)
              ? r
              : typeof r === "string"
                ? r.split(",")
                : [];
            return roles.includes("owner");
          }
        ).length;
        const targetIsOwner = targetRoles.includes("owner");
        if (targetIsOwner && ownersCount <= 1) {
          return c.json(
            { error: "Cannot remove the last organization owner" },
            403
          );
        }

        // Self-protection: do not allow removing yourself via this endpoint
        const selfUserId = c.get("user")?.id;
        const selfMember = (Array.isArray(list) ? list : []).find(
          (m: any) => m.userId === selfUserId
        );
        if (selfMember?.id === memberId) {
          return c.json(
            { error: "You cannot remove yourself from the organization" },
            403
          );
        }

        // Only owner can remove admins/owners; owner or admin can remove others
        if (targetIsAdminOrOwner) {
          if (!requesterIsOwner) {
            return c.json(
              { error: "Only organization owner can remove admins/owners" },
              403
            );
          }
        } else if (!(requesterIsOwner || requesterIsAdmin)) {
          return c.json({ error: "Forbidden" }, 403);
        }

        // Hard delete the user's account entirely using Better Auth admin API
        if (!target?.userId) {
          return c.json({ error: "Target user not found" }, 404);
        }

        await auth.api.removeUser({
          body: {
            userId: target.userId,
          },
          headers: c.req.raw.headers,
        });

        return c.json({ message: "User account deleted successfully" }, 200);
      } catch (error) {
        console.error("Error removing team member:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  .get("/invitations", requireAuth, requireOrgRole(["owner"]), async (c) => {
    try {
      const organizationId = c.get("organization")?.id;

      if (!organizationId) {
        return c.json({ error: "No organization found for this user" }, 404);
      }

      const invitations = await auth.api.listInvitations({
        query: {
          organizationId,
        },
        headers: c.req.raw.headers,
      });
      const raw = Array.isArray(invitations)
        ? invitations
        : (invitations as any)?.invitations;
      const list = Array.isArray(raw) ? raw : [];
      const pendingOnly = list.filter((i: any) => i.status === "pending");
      return c.json(pendingOnly, 200);
    } catch (error) {
      console.error("Error fetching invitations:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .delete(
    "/invitations/:invitationId",
    requireAuth,
    requireOrgRole(["owner"]),
    async (c) => {
      try {
        const invitationId = c.req.param("invitationId");

        await auth.api.cancelInvitation({
          body: {
            invitationId,
          },
          headers: c.req.raw.headers,
        });

        return c.json({ message: "Invitation cancelled successfully" }, 200);
      } catch (error) {
        console.error("Error cancelling invitation:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  );
