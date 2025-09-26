import * as React from "react";
import { Switch } from "./ui/switch";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Badge } from "./ui/badge";
import { Check } from "lucide-react";
import { currencySymbol } from "../lib/utils";
import { Plan } from "./types";
import { cn } from "../lib/utils";

interface Customer {
  id: string;
  name: string | null;
  email: string | null;
}

interface Subscription {
  id: string;
  planId: string;
  planName: string;
  status: string;
}

interface SubscriptionStatus {
  hasActiveSubscription: boolean;
  customer: Customer;
  subscription: Subscription;
}

interface PricingTableCardsProps {
  heading?: string;
  description?: string;
  plans: Plan[];
  className?: string;
  setSelectedPlan?: (plan: Plan) => void;
  subscriptionStatus?: SubscriptionStatus | null;
}

//

export const PricingTableCards = ({
  heading,
  description,
  plans,
  className,
  setSelectedPlan,
  subscriptionStatus,
}: PricingTableCardsProps) => {
  const [isYearly, setIsYearly] = React.useState(false);
  const initializedYearlyRef = React.useRef(false);

  const getGridColumnsClass = () => {
    const grid: Record<number, string> = {
      1: "grid-cols-1",
      2: "grid-cols-1 md:grid-cols-2",
      3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
      4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
    };
    return grid[plans.length] || "grid-cols-1 md:grid-cols-2 lg:grid-cols-3";
  };

  const nonEnterprisePlans = plans.filter((plan) => !plan.isEnterprisePlan);

  // Show toggle only when all non-enterprise plans have both monthly and yearly price and a yearly priceId
  const shouldShowYearlyToggle =
    nonEnterprisePlans.length > 0 &&
    nonEnterprisePlans.every(
      (plan) =>
        plan.priceMonthly !== undefined &&
        plan.priceYearly !== undefined &&
        !!plan.priceIdYearly
    );

  // Function to calculate discount percentage
  const getDiscountPercentage = (plan: Plan) => {
    if (plan.isEnterprisePlan || !isYearly) return null;

    if (plan.priceMonthly !== undefined && plan.priceYearly !== undefined) {
      const yearlyMonthlyPrice = plan.priceYearly / 12;
      const discount =
        ((plan.priceMonthly - yearlyMonthlyPrice) / plan.priceMonthly) * 100;
      return Math.round(discount);
    }

    return null;
  };

  React.useEffect(() => {
    if (shouldShowYearlyToggle) {
      if (!initializedYearlyRef.current) {
        setIsYearly(true);
        initializedYearlyRef.current = true;
      }
    } else {
      setIsYearly(false);
      initializedYearlyRef.current = false;
    }
  }, [shouldShowYearlyToggle]);

  const isCurrentPlan = (plan: Plan) => {
    return (
      subscriptionStatus?.hasActiveSubscription &&
      subscriptionStatus.subscription.planId === plan.planId
    );
  };

  const getButtonText = (plan: Plan) => {
    if (plan.isEnterprisePlan) return plan.buttonText || "Contact Sales";
    if (!subscriptionStatus?.hasActiveSubscription)
      return plan.trial?.available ? "Start Free Trial" : plan.buttonText;
    if (isCurrentPlan(plan)) return "Current Plan";
    return "Switch to Plan";
  };

  const maxDiscountPercentage = Math.max(
    ...plans.map((p) => getDiscountPercentage(p) || 0)
  );

  return (
    <div className={cn("container px-4 py-12 mx-auto", className)}>
      {heading && (
        <div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
            {heading}
          </h2>
          {description && (
            <p className="mt-4 text-lg text-muted-foreground max-w-2xl">
              {description}
            </p>
          )}
        </div>
      )}

      {shouldShowYearlyToggle && (
        <div className="relative w-full flex items-center justify-center mt-8 mb-8">
          <div className="relative inline-flex items-center space-x-3">
            <Switch checked={isYearly} onCheckedChange={setIsYearly} />
            <span
              className={`text-sm ${isYearly ? "text-foreground" : "text-muted-foreground"}`}
            >
              Pay yearly
            </span>
            {maxDiscountPercentage > 0 && (
              <Badge
                variant="secondary"
                className="absolute left-full ml-2 top-1/2 -translate-y-1/2"
              >
                Save {maxDiscountPercentage}%
              </Badge>
            )}
          </div>
        </div>
      )}

      <div
        className={`grid ${getGridColumnsClass()} gap-6 lg:gap-8 justify-center`}
      >
        {plans.map((plan, index) => {
          const discountPercentage = getDiscountPercentage(plan);
          const currentPlan = isCurrentPlan(plan);

          return (
            <Card
              key={index}
              className={cn(
                "flex flex-col justify-between relative min-h-[500px]",
                currentPlan && "ring-2 ring-blue-500 shadow-lg"
              )}
            >
              {plan.isPopular && !currentPlan && (
                <Badge className="absolute -top-2 right-4">
                  {plan.popularText || "Popular"}
                </Badge>
              )}
              {currentPlan && (
                <Badge className="absolute -top-2 right-4 bg-blue-500">
                  Current Plan
                </Badge>
              )}
              {plan.trial?.available && !currentPlan && (
                <Badge
                  variant="secondary"
                  className={`absolute -top-2 ${plan.isPopular ? "right-20" : "right-4"} bg-green-100 text-green-800 border-green-300`}
                >
                  {plan.trial.days}-day free trial
                </Badge>
              )}
              <CardHeader>
                <CardTitle className="text-xl">{plan.title}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
                {!plan.isEnterprisePlan && (
                  <div className="mt-4">
                    <div className="flex items-end space-x-2">
                      <span className="text-4xl font-bold">
                        {(() => {
                          const hasFixedPrice =
                            (plan.priceMonthly ?? plan.price) > 0 ||
                            (plan.priceYearly ?? 0) > 0;
                          const hasUsagePrice =
                            plan.pricingData?.components?.some(
                              (comp) => comp.type === "usage"
                            );
                          if (!hasFixedPrice && !hasUsagePrice) return "Free";
                          if (!hasFixedPrice && hasUsagePrice)
                            return "Pay as you go";
                          return (
                            <>
                              {plan.currency
                                ? currencySymbol(plan.currency)
                                : "€"}
                              {isYearly && plan.priceYearly
                                ? (plan.priceYearly / 12).toFixed(2)
                                : (
                                    (plan.priceMonthly ?? plan.price) ||
                                    0
                                  ).toFixed(2)}
                            </>
                          );
                        })()}
                      </span>
                      <span className="text-xl text-muted-foreground mb-1">
                        {(() => {
                          const hasFixedPrice =
                            (plan.priceMonthly ?? plan.price) > 0 ||
                            (plan.priceYearly ?? 0) > 0;
                          const hasUsagePrice =
                            plan.pricingData?.components?.some(
                              (comp) => comp.type === "usage"
                            );
                          if (!hasFixedPrice && !hasUsagePrice) return "";
                          if (!hasFixedPrice && hasUsagePrice) return "";
                          if (hasFixedPrice && hasUsagePrice)
                            return `/${plan.interval || "month"} + usage`;
                          return `/${plan.interval || "month"}`;
                        })()}
                      </span>
                    </div>
                    {plan.interval?.includes("per seat") &&
                      plan.minSeats !== undefined &&
                      plan.minSeats > 1 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Minimum {plan.minSeats} seats,{" "}
                          {plan.currency ? currencySymbol(plan.currency) : "€"}
                          {(plan.priceMonthly ?? plan.price).toFixed(2)} extra
                          per seat
                        </p>
                      )}
                    {isYearly &&
                      plan.priceMonthly !== undefined &&
                      plan.priceYearly !== undefined &&
                      ((plan.priceMonthly ?? plan.price) > 0 ||
                        plan.priceYearly > 0) && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Billed annually (
                          {plan.currency ? currencySymbol(plan.currency) : "$"}
                          {plan.priceYearly}
                          {plan.interval?.includes("per seat")
                            ? "/year per seat"
                            : "/year"}
                          )
                        </p>
                      )}
                    {plan.trial?.available && (
                      <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                        <p className="text-sm text-green-800 font-medium">
                          🎉 Start with a {plan.trial.days}-day free trial
                        </p>
                        <p className="text-xs text-green-700 mt-1">
                          After trial:{" "}
                          {plan.currency ? currencySymbol(plan.currency) : "€"}
                          {isYearly && plan.priceYearly
                            ? (plan.priceYearly / 12).toFixed(2)
                            : (plan.priceMonthly ?? plan.price).toFixed(2)}
                          /{plan.interval || "month"} + taxes
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex-1">
                {plan.features && (
                  <ul className="space-y-2">
                    {plan.features.map((feature, featureIndex) => {
                      // Split feature text to separate main text from trial info
                      const parts = feature.text.split(" • Trial: ");
                      const mainText = parts[0];
                      const trialText = parts[1];
                      const usageComponent = plan.pricingData?.components?.find(
                        (comp) => {
                          if (comp.type !== "usage") return false;

                          const slugify = (s: string) =>
                            s
                              .toLowerCase()
                              .trim()
                              .replace(/\s+/g, "-")
                              .replace(/[^a-z0-9-]/g, "-")
                              .replace(/-+/g, "-")
                              .replace(/^-|-$/g, "");

                          const baseMainText = mainText
                            .replace(/\s*\(.*?\)\s*$/, "")
                            .trim();
                          const mainTextSlug = slugify(baseMainText);

                          let compSlug = "";
                          if (
                            typeof (comp as any).component_name === "string" &&
                            (comp as any).component_name
                          ) {
                            const raw = (comp as any).component_name
                              .replace(/^usage[_-]?/i, "")
                              .replace(/[_-]?usage$/i, "");
                            compSlug = slugify(raw);
                          } else if (
                            typeof (comp as any).unit_label === "string" &&
                            (comp as any).unit_label
                          ) {
                            compSlug = slugify(
                              (comp as any).unit_label as string
                            );
                          } else if (
                            typeof (comp as any).label === "string" &&
                            (comp as any).label
                          ) {
                            const raw = ((comp as any).label as string).replace(
                              /\s+usage$/i,
                              ""
                            );
                            compSlug = slugify(raw);
                          }

                          if (compSlug && mainTextSlug) {
                            return compSlug === mainTextSlug;
                          }

                          // Fallback to normalized name equality
                          let featureName = "";
                          if ((comp as any).label) {
                            featureName = (
                              (comp as any).label as string
                            ).replace(/\s+usage$/i, "");
                          } else if ((comp as any).component_name) {
                            const name = (
                              (comp as any).component_name as string
                            ).replace(/^usage_/, "");
                            featureName = name
                              .replace(/-/g, " ")
                              .replace(/\b\w/g, (l: string) => l.toUpperCase());
                          }
                          const normalize = (s: string) =>
                            s.toLowerCase().replace(/\s+/g, " ").trim();
                          return (
                            normalize(baseMainText) === normalize(featureName)
                          );
                        }
                      );

                      return (
                        <li key={featureIndex} className="flex items-start">
                          <Check className="h-4 w-4 mr-2 mt-0.5 flex-shrink-0" />
                          <div className="flex-1">
                            <span>{mainText}</span>
                            {usageComponent && (
                              <div className="text-xs text-muted-foreground mt-1">
                                {(() => {
                                  const pricePerUnit = (usageComponent as any)
                                    .unit_cost_cents
                                    ? (usageComponent as any).unit_cost_cents /
                                      100
                                    : 0;
                                  const currency = plan.currency || "usd";
                                  const symbol =
                                    currency.toLowerCase() === "usd"
                                      ? "$"
                                      : currency.toLowerCase() === "eur"
                                        ? "€"
                                        : currency.toUpperCase();
                                  const hasAllowance =
                                    /\(\d+\s+(per\s+(month|year)|included)\)/.test(
                                      mainText
                                    );
                                  const prefix = hasAllowance ? "Then " : "";
                                  return `${prefix}${symbol}${pricePerUnit.toFixed(pricePerUnit < 0.01 ? 4 : 2)} per use`;
                                })()}
                              </div>
                            )}
                            {trialText && (
                              <div className="text-xs text-muted-foreground mt-0.5">
                                Trial: {trialText}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
              <CardFooter className="mt-auto">
                <Button
                  className="w-full"
                  variant={
                    currentPlan
                      ? "secondary"
                      : plan.buttonOutline
                        ? "outline"
                        : "default"
                  }
                  disabled={currentPlan}
                  onClick={() => {
                    if (currentPlan) return;
                    if (plan.isEnterprisePlan && plan.enterpriseRedirectUrl) {
                      window.open(plan.enterpriseRedirectUrl, "_blank");
                    } else {
                      const allowYearly =
                        isYearly &&
                        plan.priceYearly !== undefined &&
                        !!plan.priceIdYearly;
                      const planWithBillingInfo = {
                        ...plan,
                        selectedBillingInterval: allowYearly
                          ? "yearly"
                          : "monthly",
                        selectedPrice: allowYearly
                          ? (plan.priceYearly as number)
                          : plan.priceMonthly || plan.price,
                      } as Plan;
                      setSelectedPlan?.(planWithBillingInfo);
                    }
                  }}
                >
                  {getButtonText(plan)}
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
};
