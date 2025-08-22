"use client";
import * as React from "react";
import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowUpDown,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Loader2,
  Trash2,
  Timer,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/hono-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { z } from "zod";
import { subscriptionsSelectSchema } from "@lumen/common/schema";
import { FailedToLoadError } from "@/components/dashboard/failed-to-load-error";
import { PageContent } from "@/components/dashboard/page-content";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";
import { formatCurrency } from "@lumen/common/utils";
import { PerUnitPriceComponentSchemaType } from "@lumen/common";
import { useSession } from "@/lib/auth-client";

// Define the type for subscription with mapped stableSubscriptionId to id and relations
type Subscription = Omit<
  z.infer<typeof subscriptionsSelectSchema>,
  "stableSubscriptionId"
> & {
  id: string; // This is actually stableSubscriptionId that got mapped by the API
  customer: {
    id: string;
    name: string | null;
    email: string | null;
    billingCountry: string | null;
  };
  plan: {
    id: string;
    planName: string;
    planDescription: string | null;
    stablePlanId: string;
    versionNumber: number;
    isTrialPlan?: boolean;
    trialDays?: number;
  };
  price: {
    id: string;
    currency: string;
    pricingData: {
      components: Array<{
        type: string;
        amount_cents?: number;
        recurrence_rule?: string;
        unit_cost_cents?: number;
        bill_immediately?: boolean;
      }>;
    };
  };
};

const CREATE_SUBSCRIPTION_ROUTE = "/subscriptions/create";

// Interface for price components
interface PriceComponent {
  type: string;
  amount_cents?: number;
  per_unit_cents?: number;
  unit_cost_cents?: number;
  recurrence_rule?: string;
  component_name?: string;
  label?: string;
  bill_immediately?: boolean;
  component_id?: string;
  metric_id?: string;
  unit_label?: string;
}

// Interface for prices with components (enhanced to match create page)
interface PriceWithComponents {
  id: string;
  currency: string;
  interval?: string;
  intervalCount?: number;
  nickname?: string;
  pricingData: {
    components: PriceComponent[];
  };
}

// Helper function to get component amount
const getComponentAmount = (component: PriceComponent): number => {
  return (
    component.amount_cents ??
    component.per_unit_cents ??
    component.unit_cost_cents ??
    0
  );
};

// Helper function to get component label/unit
const getComponentUnit = (component: PriceComponent): string => {
  if (component.type === "fixed") return "";
  if (component.type === "per_unit") return "per unit";
  if (component.type === "usage") {
    if (component.unit_label) return `per ${component.unit_label}`;
    return "per use";
  }
  return "";
};

// Helper function to format recurrence/billing period
const formatRecurrence = (recurrence?: string) => {
  if (!recurrence) return "One-time";
  const lower = recurrence.toLowerCase();
  if (lower.includes("month")) return "monthly";
  if (lower.includes("year")) return "yearly";
  if (lower.includes("week")) return "weekly";
  if (lower.includes("day")) return "daily";
  return recurrence;
};

// Helper function to get billing period from price or component (enhanced version from create page)
const getBillingPeriod = (
  price: PriceWithComponents,
  component?: PriceComponent
): string => {
  // First try to get period from the price itself
  if (price.nickname) {
    const lower = price.nickname.toLowerCase();
    if (lower.includes("monthly") || lower.includes("month")) return "monthly";
    if (lower.includes("yearly") || lower.includes("year")) return "yearly";
    if (lower.includes("weekly") || lower.includes("week")) return "weekly";
    if (lower.includes("daily") || lower.includes("day")) return "daily";
  }

  // Then try price interval
  if (price.interval) {
    const count = price.intervalCount || 1;
    const interval = price.interval.toLowerCase();

    if (count === 1) {
      switch (interval) {
        case "month":
          return "monthly";
        case "year":
          return "yearly";
        case "week":
          return "weekly";
        case "day":
          return "daily";
        default:
          return interval;
      }
    } else {
      // Handle multiple intervals (e.g., "every 3 months")
      const intervalName =
        interval === "month"
          ? "month"
          : interval === "year"
            ? "year"
            : interval;
      return `every ${count} ${intervalName}${count > 1 ? "s" : ""}`;
    }
  }

  // Finally try component recurrence rule
  if (component?.recurrence_rule) {
    return formatRecurrence(component.recurrence_rule);
  }

  return "once";
};

// Helper function to format price display
const formatPriceDisplay = (subscription: Subscription): string => {
  if (!subscription.price) {
    return "No pricing";
  }

  const components = subscription.price?.pricingData?.components || [];

  if (components.length === 0) {
    return "No pricing";
  }

  // Create a price-like object for getBillingPeriod function
  const priceInfo: PriceWithComponents = {
    id: subscription.price.id,
    currency: subscription.price.currency,
    pricingData: subscription.price.pricingData,
    // These might not be available in the subscription price object, but we'll try
    nickname: undefined,
    interval: undefined,
    intervalCount: undefined,
  };

  const formattedComponents = components.map((component) => {
    const amount = getComponentAmount(component);
    const unit = getComponentUnit(component);
    const period = getBillingPeriod(priceInfo, component);

    if (amount === 0) {
      return `Free ${component.type} ${period}`;
    }

    const currencyFormatted = formatCurrency(
      amount,
      subscription.price.currency
    );
    const typeLabel = component.type === "fixed" ? "fixed" : component.type;

    if (unit) {
      return `${currencyFormatted} ${unit} ${period}`;
    } else {
      return `${currencyFormatted} ${typeLabel} ${period}`;
    }
  });

  if (components.length === 1) {
    return formattedComponents[0];
  } else {
    return formattedComponents.join(" + ");
  }
};

// Helper function to calculate MRR contribution from subscription (returns cents)
const calculateMRRContribution = (subscription: Subscription): number => {
  if (!subscription.price?.pricingData?.components) return 0;

  let mrrCents = 0;
  for (const component of subscription.price.pricingData.components) {
    const amount = getComponentAmount(component);
    if (!amount) continue;

    const recurrenceRule = component.recurrence_rule || "";

    if (component.type === "fixed") {
      // Fixed components: amount is the total monthly or yearly charge
      if (recurrenceRule.includes("FREQ=MONTHLY")) {
        mrrCents += amount;
      } else if (recurrenceRule.includes("FREQ=YEARLY")) {
        mrrCents += Math.round(amount / 12);
      }
    } else if (component.type === "per_unit") {
      // Seat-based per_unit components: amount is per seat per billing period
      // Note: This calculates base MRR assuming minimum seats (since we don't have
      // actual seat usage data per subscription in this list view)
      const minSeats =
        (component as PerUnitPriceComponentSchemaType).num_seats || 1;

      if (recurrenceRule.includes("FREQ=MONTHLY")) {
        // amount is per seat per month
        mrrCents += amount * minSeats;
      } else if (recurrenceRule.includes("FREQ=YEARLY")) {
        // amount is per seat per year, so divide by 12 to get per seat per month
        mrrCents += Math.round((amount * minSeats) / 12);
      }
    }
    // Note: usage-based components are not included in MRR calculation
    // as they are variable and unpredictable
  }
  return mrrCents;
};

// Helper function to get billing frequency
const getBillingFrequency = (subscription: Subscription): string => {
  if (!subscription.price?.pricingData?.components) return "Unknown";

  for (const component of subscription.price.pricingData.components) {
    // Check both fixed and per_unit components for recurrence rules
    if (
      (component.type !== "fixed" && component.type !== "per_unit") ||
      !component.recurrence_rule
    )
      continue;

    const recurrenceRule = component.recurrence_rule;
    if (recurrenceRule.includes("FREQ=MONTHLY")) return "Monthly";
    if (recurrenceRule.includes("FREQ=YEARLY")) return "Yearly";
    if (recurrenceRule.includes("FREQ=WEEKLY")) return "Weekly";
    if (recurrenceRule.includes("FREQ=DAILY")) return "Daily";
  }
  return "One-time";
};

// Helper function to get subscription status
const getSubscriptionStatus = (
  subscription: Subscription
): "active" | "ended" => {
  return subscription.endTimestamp ? "ended" : "active";
};

// Helper function to check if subscription is on trial
const isTrialSubscription = (subscription: Subscription): boolean => {
  return subscription.plan?.isTrialPlan === true;
};

// Helper function to get trial badge
const getTrialBadge = (subscription: Subscription) => {
  if (!isTrialSubscription(subscription)) return null;

  return {
    text: "Trial",
    className: "bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200",
    icon: <Timer className="w-3 h-3" />,
  };
};

// Using centralized formatCurrency from @lumen/common/utils (with Dinero.js)

const SubscriptionActions = ({
  subscription,
}: {
  subscription: Subscription;
}) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">Open menu</span>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(subscription.id);
          }}
        >
          Copy subscription ID
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            href={`/subscriptions/${subscription.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            View subscription
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link
            href={`/subscriptions/${subscription.id}?edit=true`}
            onClick={(e) => e.stopPropagation()}
          >
            Edit subscription
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default function SubscriptionsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  router.prefetch(CREATE_SUBSCRIPTION_ROUTE);

  const handleCreateSubscription = useCallback(() => {
    router.push(CREATE_SUBSCRIPTION_ROUTE);
  }, [router]);

  const deleteSubscriptionsMutation = useMutation({
    mutationFn: async (stableSubscriptionIds: string[]) => {
      const deletePromises = stableSubscriptionIds.map((stableSubscriptionId) =>
        apiClient.subscriptions[":id"].$delete({
          param: { id: stableSubscriptionId },
        })
      );
      await Promise.all(deletePromises);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      setRowSelection({});
    },
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isCommandPaletteOpen =
        document.querySelector('[role="dialog"][data-state="open"]') !== null;

      if (
        event.key.toLowerCase() === "n" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !isCommandPaletteOpen
      ) {
        event.preventDefault();
        handleCreateSubscription();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCreateSubscription]);

  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState({});
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [planFilter, setPlanFilter] = React.useState<string>("all");

  const {
    data: subscriptions,
    isPending,
    isError,
  } = useQuery({
    queryKey: ["subscriptions"],
    queryFn: async () => {
      const response = await apiClient.subscriptions.$get();
      const data = await response.json();
      if (!data.subscriptions) {
        throw new Error("No subscriptions data received");
      }
      return data.subscriptions.map((subscription) => ({
        ...subscription,
        createdAt: new Date(subscription.createdAt),
        deletedAt: subscription.deletedAt
          ? new Date(subscription.deletedAt)
          : null,
        startTimestamp: new Date(subscription.startTimestamp),
        endTimestamp: subscription.endTimestamp
          ? new Date(subscription.endTimestamp)
          : null,
      })) as Subscription[];
    },
  });

  // Only initialize the table if we have data and no error
  const tableData = React.useMemo(
    () => (isError ? [] : subscriptions || []),
    [isError, subscriptions]
  );

  // Apply additional filters
  const filteredData = React.useMemo(() => {
    if (!tableData.length) return tableData;

    return tableData.filter((subscription) => {
      const status = getSubscriptionStatus(subscription);
      const planName = subscription.plan.planName;

      const statusMatch = statusFilter === "all" || status === statusFilter;
      const planMatch = planFilter === "all" || planName === planFilter;

      return statusMatch && planMatch;
    });
  }, [tableData, statusFilter, planFilter]);

  // Get unique plans for filter dropdown and determine which have multiple versions
  const { uniquePlans, plansWithMultipleVersions } = React.useMemo(() => {
    const plans = new Set(tableData.map((sub) => sub.plan.planName));

    // Track which stablePlanIds have multiple versions
    const stablePlanVersionCounts = new Map<string, Set<number>>();
    tableData.forEach((sub) => {
      const { stablePlanId, versionNumber } = sub.plan;
      if (!stablePlanVersionCounts.has(stablePlanId)) {
        stablePlanVersionCounts.set(stablePlanId, new Set());
      }
      stablePlanVersionCounts.get(stablePlanId)!.add(versionNumber);
    });

    // Identify plans with multiple versions
    const multiVersionPlans = new Set<string>();
    stablePlanVersionCounts.forEach((versions, stablePlanId) => {
      if (versions.size > 1) {
        multiVersionPlans.add(stablePlanId);
      }
    });

    return {
      uniquePlans: Array.from(plans).sort(),
      plansWithMultipleVersions: multiVersionPlans,
    };
  }, [tableData]);

  const columns: ColumnDef<Subscription>[] = React.useMemo(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(!!value)
            }
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            onClick={(e) => e.stopPropagation()}
            aria-label="Select row"
          />
        ),
        enableSorting: false,
        enableHiding: false,
        size: 50,
        minSize: 50,
        maxSize: 50,
      },
      {
        id: "customer",
        accessorFn: (row) =>
          row.customer?.name || row.customer?.email || "Unknown",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Customer
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const customer = row.original.customer;
          return (
            <div className="space-y-1 min-w-0">
              <div className="font-medium truncate">
                {customer?.name || "Unknown"}
              </div>
              <div className="text-sm text-muted-foreground truncate">
                {customer?.email || "No email"}
              </div>
            </div>
          );
        },
        size: 280,
        minSize: 200,
      },
      {
        id: "plan",
        accessorFn: (row) => row.plan?.planName || "Unknown",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Plan
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const plan = row.original.plan;
          if (!plan) {
            return (
              <div className="space-y-1 min-w-0">
                <div className="font-medium truncate">Unknown Plan</div>
              </div>
            );
          }

          const hasMultipleVersions = plansWithMultipleVersions.has(
            plan.stablePlanId
          );
          const displayName = hasMultipleVersions
            ? `${plan.planName} (v${plan.versionNumber})`
            : plan.planName;

          const trialBadge = getTrialBadge(row.original);

          return (
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2">
                <div className="font-medium truncate">{displayName}</div>
                {trialBadge && (
                  <Badge className={trialBadge.className}>
                    {trialBadge.icon}
                    <span className="ml-1 text-xs font-medium">
                      {trialBadge.text}
                    </span>
                  </Badge>
                )}
              </div>
              {plan.planDescription && (
                <div className="text-sm text-muted-foreground truncate">
                  {plan.planDescription}
                </div>
              )}
            </div>
          );
        },
        size: 300,
        minSize: 200,
      },
      {
        id: "status",
        accessorFn: (row) => getSubscriptionStatus(row),
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Status
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const status = getSubscriptionStatus(row.original);
          if (status === "active") {
            return (
              <Badge className="bg-green-100 text-green-800 border-green-200 hover:bg-green-200">
                Active
              </Badge>
            );
          } else {
            return (
              <Badge className="bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200">
                Ended
              </Badge>
            );
          }
        },
        size: 100,
        minSize: 80,
      },
      {
        id: "pricing",
        accessorFn: (row) => formatPriceDisplay(row),
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Pricing
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const priceDisplay = formatPriceDisplay(row.original);
          return <div className="font-medium text-sm">{priceDisplay}</div>;
        },
        size: 180,
        minSize: 140,
      },
      {
        id: "billing",
        accessorFn: (row) => getBillingFrequency(row),
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Billing
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const frequency = getBillingFrequency(row.original);
          return <div className="text-sm">{frequency}</div>;
        },
        size: 100,
        minSize: 80,
      },
      {
        accessorKey: "startTimestamp",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Start Date
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const value = row.getValue("startTimestamp");
          return (
            <LocaleAwareDate
              date={value as string | Date | null}
              fallback="-"
              className="text-sm"
            />
          );
        },
        size: 120,
        minSize: 100,
      },
      {
        id: "country",
        accessorFn: (row) => row.customer?.billingCountry || "Unknown",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Country
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const country = row.original.customer?.billingCountry;
          return <div className="text-sm">{country || "Unknown"}</div>;
        },
        size: 100,
        minSize: 80,
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => {
          const subscription = row.original;
          return <SubscriptionActions subscription={subscription} />;
        },
        size: 60,
        minSize: 60,
        maxSize: 60,
      },
    ],
    [plansWithMultipleVersions]
  );

  const table = useReactTable({
    data: filteredData,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
    globalFilterFn: (row, columnId, filterValue) => {
      const subscription = row.original;
      const searchValue = filterValue.toLowerCase();
      return (
        subscription.customer.name?.toLowerCase().includes(searchValue) ||
        subscription.customer.email?.toLowerCase().includes(searchValue) ||
        subscription.plan.planName.toLowerCase().includes(searchValue) ||
        subscription.plan.planDescription
          ?.toLowerCase()
          .includes(searchValue) ||
        subscription.price.currency.toLowerCase().includes(searchValue)
      );
    },
  });

  const handleDeleteSelected = () => {
    const selectedRows = table.getSelectedRowModel().rows;
    const subscriptionIds = selectedRows.map((row) => row.original.id);
    deleteSubscriptionsMutation.mutate(subscriptionIds);
  };

  // Calculate summary statistics
  const summaryStats = React.useMemo(() => {
    if (!subscriptions || subscriptions.length === 0) {
      return {
        totalSubscriptions: 0,
        activeSubscriptions: 0,
        totalMRRCents: 0,
        averageMRRCents: 0,
        currency: undefined,
      };
    }

    const activeSubscriptions = subscriptions.filter(
      (sub) => getSubscriptionStatus(sub) === "active"
    );
    const totalMRRCents = activeSubscriptions.reduce(
      (sum, sub) => sum + calculateMRRContribution(sub),
      0
    );
    const averageMRRCents =
      activeSubscriptions.length > 0
        ? Math.round(totalMRRCents / activeSubscriptions.length) // Dinero.js does not support decimals
        : 0;

    // Careful currency fallback - try to get from actual subscription data first
    let currency: string | undefined;

    // First try: get from active subscriptions (most relevant)
    if (activeSubscriptions.length > 0) {
      currency = activeSubscriptions.find((sub) => sub.price?.currency)?.price
        ?.currency;
    }

    // Second try: get from any subscription with currency data
    if (!currency && subscriptions.length > 0) {
      currency = subscriptions.find((sub) => sub.price?.currency)?.price
        ?.currency;
    }

    // Final fallback only when absolutely no currency data exists
    if (!currency) {
      currency = session?.merchant?.defaultCurrency || "USD";
    }

    return {
      totalSubscriptions: subscriptions.length,
      activeSubscriptions: activeSubscriptions.length,
      totalMRRCents,
      averageMRRCents,
      currency,
    };
  }, [subscriptions, session]);

  return (
    <PageContent
      title="Subscriptions"
      actions={
        <div className="flex gap-2">
          {table.getSelectedRowModel().rows.length > 0 && (
            <Button
              variant="destructive"
              onClick={handleDeleteSelected}
              disabled={deleteSubscriptionsMutation.isPending}
            >
              {deleteSubscriptionsMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Selected
                </>
              )}
            </Button>
          )}
          <Link href="/subscriptions/create">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Subscription
              <kbd className="ml-2 pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[14px] font-medium text-muted-foreground opacity-100">
                N
              </kbd>
            </Button>
          </Link>
        </div>
      }
    >
      <div className="w-full">
        {/* Summary Statistics */}
        {!isPending &&
          !isError &&
          (() => {
            // Careful currency fallback for summary stats display
            const displayCurrency =
              summaryStats.currency ||
              session?.merchant?.defaultCurrency ||
              "USD";

            return (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-card rounded-lg border p-4">
                  <div className="text-sm text-muted-foreground">
                    Total Subscriptions
                  </div>
                  <div className="text-2xl font-bold">
                    {summaryStats.totalSubscriptions}
                  </div>
                </div>
                <div className="bg-card rounded-lg border p-4">
                  <div className="text-sm text-muted-foreground">
                    Active Subscriptions
                  </div>
                  <div className="text-2xl font-bold text-green-600">
                    {summaryStats.activeSubscriptions}
                  </div>
                </div>
                <div className="bg-card rounded-lg border p-4">
                  <div className="text-sm text-muted-foreground">Total MRR</div>
                  <div className="text-2xl font-bold">
                    {formatCurrency(
                      summaryStats.totalMRRCents,
                      displayCurrency
                    )}
                  </div>
                </div>
                <div className="bg-card rounded-lg border p-4">
                  <div className="text-sm text-muted-foreground">
                    Average MRR
                  </div>
                  <div className="text-2xl font-bold">
                    {formatCurrency(
                      summaryStats.averageMRRCents,
                      displayCurrency
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

        <div className="flex items-center py-4 gap-4">
          <Input
            placeholder="Search by customer name, email, plan name..."
            value={table.getState().globalFilter ?? ""}
            onChange={(event) => table.setGlobalFilter(event.target.value)}
            className="max-w-sm"
            disabled={isPending || isError}
          />

          {/* Status Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={isPending || isError}>
                Status:{" "}
                {statusFilter === "all"
                  ? "All"
                  : statusFilter === "active"
                    ? "Active"
                    : "Ended"}
                <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setStatusFilter("all")}>
                All
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter("active")}>
                Active
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter("ended")}>
                Ended
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Plan Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={isPending || isError}>
                Plan: {planFilter === "all" ? "All" : planFilter}
                <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setPlanFilter("all")}>
                All Plans
              </DropdownMenuItem>
              {uniquePlans.map((plan) => (
                <DropdownMenuItem
                  key={plan}
                  onClick={() => setPlanFilter(plan)}
                >
                  {plan}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="ml-auto"
                disabled={isPending || isError}
              >
                Columns <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {table
                .getAllColumns()
                .filter((column) => column.getCanHide())
                .map((column) => {
                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      className="capitalize"
                      checked={column.getIsVisible()}
                      onCheckedChange={(value) =>
                        column.toggleVisibility(!!value)
                      }
                    >
                      {column.id}
                    </DropdownMenuCheckboxItem>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {isError ? (
          <FailedToLoadError />
        ) : (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header) => {
                        return (
                          <TableHead key={header.id}>
                            {header.isPlaceholder
                              ? null
                              : flexRender(
                                  header.column.columnDef.header,
                                  header.getContext()
                                )}
                          </TableHead>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {isPending ? (
                    Array.from({ length: 5 }).map((_, index) => (
                      <TableRow key={index}>
                        {columns.map((column, i) => (
                          <TableCell key={`skeleton-${i}`}>
                            <Skeleton className="h-4 w-[100px]" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : table.getRowModel().rows?.length ? (
                    table.getRowModel().rows.map((row) => (
                      <TableRow
                        key={row.id}
                        data-state={row.getIsSelected() && "selected"}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() =>
                          router.push(`/subscriptions/${row.original.id}`)
                        }
                      >
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id}>
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext()
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={columns.length}
                        className="h-24 text-center"
                      >
                        No results.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-end space-x-2 py-4">
              <div className="flex-1 text-sm text-muted-foreground">
                {table.getFilteredSelectedRowModel().rows.length} of{" "}
                {table.getFilteredRowModel().rows.length} row(s) selected.
              </div>
              <div className="space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </PageContent>
  );
}
