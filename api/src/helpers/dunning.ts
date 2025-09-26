import { and, eq, gte, isNull, or } from "drizzle-orm";
import {
  subscriptions,
  subscriptionDetails as subscriptionDetailsTable,
  subscriptionFeatures,
  creditGrants,
} from "@lumen/common/schema";
import { TransactionType } from "./index";
import { createNotificationProvider } from "./notificationProvider";
import { db } from "../db/client";
import { merchants } from "@lumen/common/schema";
import { downgradeSubscriptionToFreeAndInvoice } from "./billing";

type DunningAction =
  | "pause_subscription"
  | "cancel_subscription"
  | "mark_as_unpaid";

export async function enforceDunningEndAction({
  tx,
  subscriptionId,
  action,
  currentTimestamp = new Date(),
}: {
  tx: TransactionType;
  subscriptionId: string;
  action: DunningAction;
  currentTimestamp?: Date;
}): Promise<void> {
  const notify = createNotificationProvider();
  const subFull = await tx.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscriptionId),
    with: {
      customer: true,
    },
  });
  const merchantRecord = subFull
    ? await tx.query.merchants.findFirst({
        where: eq(merchants.id, subFull.merchantId),
      })
    : null;
  const merchantName =
    merchantRecord?.displayName ||
    merchantRecord?.legalName ||
    "Your Service Provider";
  const customerEmail = subFull?.customer?.email || null;
  const merchantNotifyEmail =
    merchantRecord?.billingEmail || merchantRecord?.supportEmail || null;

  if (action === "pause_subscription") {
    await tx
      .update(subscriptions)
      .set({ status: "paused", gracePeriodEndsAt: null })
      .where(eq(subscriptions.id, subscriptionId));

    if (customerEmail) {
      await notify.sendEmail({
        to: customerEmail,
        subject: `Subscription paused at ${merchantName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Your subscription is paused</h2>
            <p>Your subscription has been paused due to unresolved payment issues.</p>
            <p>Update your payment method to resume access.</p>
            <p>Best regards,<br>${merchantName}</p>
          </div>
        `,
        from: "noreply@getlumen.dev",
      });
    }
    if (merchantNotifyEmail) {
      await notify.sendEmail({
        to: merchantNotifyEmail,
        subject: `Dunning enforcement applied (paused)`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Subscription paused</h2>
            <p>Subscription ${subscriptionId} was paused after grace period ended.</p>
          </div>
        `,
        from: "noreply@getlumen.dev",
      });
    }
  }

  if (action === "cancel_subscription") {
    // Preferred path: downgrade to free plan (new subscription version) if available
    try {
      if (!subFull) throw new Error("Subscription not found");
      const result = await downgradeSubscriptionToFreeAndInvoice({
        merchantId: subFull.merchantId,
        customerId: subFull.customerId,
        existingSubscription: subFull,
        tx,
      });

      if (customerEmail) {
        await notify.sendEmail({
          to: customerEmail,
          subject: `Moved to free plan at ${merchantName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Your paid subscription ended</h2>
              <p>We couldn't recover payment after the grace period. We've moved your account to our free plan so you keep basic access.</p>
              <p>You can upgrade anytime after updating your payment method.</p>
              <p>Best regards,<br>${merchantName}</p>
            </div>
          `,
          from: "noreply@getlumen.dev",
        });
      }
      if (merchantNotifyEmail) {
        await notify.sendEmail({
          to: merchantNotifyEmail,
          subject: `Dunning enforcement applied (downgraded to free)`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Subscription downgraded to free</h2>
              <p>Subscription ${subscriptionId} was downgraded to a free plan after grace period ended.</p>
            </div>
          `,
          from: "noreply@getlumen.dev",
        });
      }
      return;
    } catch (e) {
      // Fallback: perform legacy cancel flow
      await tx
        .update(subscriptions)
        .set({
          status: "canceled",
          endTimestamp: currentTimestamp,
          gracePeriodEndsAt: null,
        })
        .where(eq(subscriptions.id, subscriptionId));

      await tx
        .update(subscriptionDetailsTable)
        .set({ deletedAt: currentTimestamp })
        .where(
          and(
            eq(subscriptionDetailsTable.subscriptionId, subscriptionId),
            isNull(subscriptionDetailsTable.deletedAt)
          )
        );

      await tx
        .update(subscriptionFeatures)
        .set({ deletedAt: currentTimestamp })
        .where(
          and(
            eq(subscriptionFeatures.subscriptionId, subscriptionId),
            isNull(subscriptionFeatures.deletedAt)
          )
        );

      const sub = await tx.query.subscriptions.findFirst({
        where: eq(subscriptions.id, subscriptionId),
      });
      if (sub?.planId && sub?.customerId) {
        await tx
          .update(creditGrants)
          .set({
            expiryDate: currentTimestamp,
            status: "EXPIRED",
            nextRenewalDate: null,
            updatedAt: currentTimestamp,
          })
          .where(
            and(
              eq(creditGrants.customerId, sub.customerId),
              eq(creditGrants.planId, sub.planId),
              eq(creditGrants.scope, "plan"),
              or(
                eq(creditGrants.status, "ACTIVE"),
                gte(creditGrants.expiryDate, currentTimestamp)
              ),
              isNull(creditGrants.deletedAt)
            )
          );
      }
      if (customerEmail) {
        await notify.sendEmail({
          to: customerEmail,
          subject: `Subscription canceled at ${merchantName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Your subscription has been canceled</h2>
              <p>Your subscription was canceled after the grace period ended and payment could not be recovered.</p>
              <p>You can re-subscribe after updating your payment method.</p>
              <p>Best regards,<br>${merchantName}</p>
            </div>
          `,
          from: "noreply@getlumen.dev",
        });
      }
      if (merchantNotifyEmail) {
        await notify.sendEmail({
          to: merchantNotifyEmail,
          subject: `Dunning enforcement applied (canceled)`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Subscription canceled</h2>
              <p>Subscription ${subscriptionId} was canceled after grace period ended.</p>
            </div>
          `,
          from: "noreply@getlumen.dev",
        });
      }
    }
  }

  if (action === "mark_as_unpaid") {
    await tx
      .update(subscriptions)
      .set({
        status: "unpaid",
        endTimestamp: currentTimestamp,
        gracePeriodEndsAt: null,
      })
      .where(eq(subscriptions.id, subscriptionId));

    if (customerEmail) {
      await notify.sendEmail({
        to: customerEmail,
        subject: `Account marked as unpaid at ${merchantName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Account marked as unpaid</h2>
            <p>Your subscription continues, but your account is marked as unpaid due to unresolved payment.</p>
            <p>Please update your payment method or contact billing.</p>
            <p>Best regards,<br>${merchantName}</p>
          </div>
        `,
        from: "noreply@getlumen.dev",
      });
    }
    if (merchantNotifyEmail) {
      await notify.sendEmail({
        to: merchantNotifyEmail,
        subject: `Dunning enforcement applied (marked as unpaid)`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Subscription marked as unpaid</h2>
            <p>Subscription ${subscriptionId} was marked as unpaid after grace period ended.</p>
          </div>
        `,
        from: "noreply@getlumen.dev",
      });
    }
  }
}
