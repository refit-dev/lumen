"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import { apiClient } from "@/lib/hono-client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PageContent } from "@/components/dashboard/page-content";
import {
  CheckCircle,
  ArrowRight,
  CreditCard,
  User,
  DollarSign,
  TrendingUp,
  Activity,
  Target,
  FileText,
  BarChart3,
  Users,
  ExternalLink,
  Check,
} from "lucide-react";
import { formatCurrency } from "@lumen/common/utils";
import { PerUnitPriceComponentSchemaType } from "@lumen/common";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";
import {
  ChartContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface OnboardingItem {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  action?: () => void;
}

interface DashboardMetrics {
  totalCustomers: number;
  activeSubscriptions: number;
  monthlyRecurringRevenue: number;
  averageRevenuePerUser: number;
  currency: string;
}

interface RecentActivity {
  id: string;
  type: "subscription" | "invoice" | "payment" | "customer";
  title: string;
  subtitle: string;
  amount?: number;
  currency?: string;
  timestamp: Date;
  status?: "success" | "pending" | "failed";
  planName?: string; // For showing plan information
}

interface Payment {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  refundStatus?: string | null;
  refundedAmountCents?: number | null;
  customerName?: string;
  invoiceNumber?: string;
  invoiceId?: string;
  createdAt: Date;
  // Related entity information
  subscriptionId?: string;
  subscriptionStableId?: string;
  planId?: string;
  planName?: string;
}

interface PaymentChartData {
  date: string;
  amount: number;
  count: number;
}

// Define the type for subscription data for MRR calculation
interface SubscriptionForMRR {
  endTimestamp?: string | null;
  price?: {
    currency?: string;
    pricingData?: {
      components?: Array<{
        type?: string;
        amount_cents?: number;
        recurrence_rule?: string;
        num_seats?: number;
      }>;
    };
  };
}

// Helper function to calculate MRR contribution from subscription (returns cents)
const calculateMRRContribution = (subscription: SubscriptionForMRR): number => {
  if (!subscription.price?.pricingData?.components) return 0;

  let mrrCents = 0;
  for (const component of subscription.price.pricingData.components) {
    const amount = component.amount_cents;
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
      // actual seat usage data per subscription in this dashboard view)
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

// Helper function to get subscription status
const getSubscriptionStatus = (
  subscription: SubscriptionForMRR
): "active" | "ended" => {
  return subscription.endTimestamp ? "ended" : "active";
};

export default function DashboardPage() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [onboardingItems, setOnboardingItems] = useState<OnboardingItem[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics>({
    totalCustomers: 0,
    activeSubscriptions: 0,
    monthlyRecurringRevenue: 0,
    averageRevenuePerUser: 0,
    currency: session?.merchant?.defaultCurrency || "USD", // Default currency with merchant fallback
  });
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  const [recentPayments, setRecentPayments] = useState<Payment[]>([]);
  const [paymentChartData, setPaymentChartData] = useState<PaymentChartData[]>(
    []
  );
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [selectedTimeRange, setSelectedTimeRange] = useState<number>(7);
  const [selectedMetric, setSelectedMetric] = useState<"volume" | "count">(
    "volume"
  );

  useEffect(() => {
    const getOnboardingItems = async (): Promise<OnboardingItem[]> => {
      const items: OnboardingItem[] = [];

      try {
        let hasPlans = false;
        let hasPaymentProvider = false;
        let hasTax = false;
        try {
          const onboardingResponse =
            await apiClient.merchants.checkonboarding.$get();
          if (onboardingResponse.ok) {
            const onboardingData = await onboardingResponse.json();
            hasPlans = onboardingData.hasPlans;
            hasPaymentProvider = onboardingData.hasPaymentProvider;
            hasTax = onboardingData.hasTax;
          }
        } catch (error) {
          console.error("Error checking onboarding status:", error);
        }

        items.push({
          id: "create-plan",
          title: "Create your first pricing plan",
          description: "Set up subscription plans for your customers",
          completed: hasPlans,
          action: hasPlans ? undefined : () => router.push("/plans/create"),
        });

        items.push({
          id: "setup-payment-provider",
          title: "Configure payment provider",
          description: "Connect your payment provider to process payments",
          completed: hasPaymentProvider,
          action: hasPaymentProvider
            ? undefined
            : () => router.push("/developer/paymentprovider"),
        });

        items.push({
          id: "setup-tax",
          title: "Configure tax settings",
          description: "Set up tax calculation for your business",
          completed: hasTax,
          action: hasTax ? undefined : () => router.push("/tax"),
        });
      } catch (error) {
        console.error("Error checking onboarding status:", error);
      }
      return items;
    };

    const fetchDashboardMetrics = async (): Promise<DashboardMetrics> => {
      try {
        setMetricsLoading(true);

        // Fetch customers and subscriptions in parallel
        const [customersResponse, subscriptionsResponse] = await Promise.all([
          apiClient.customers.$get(),
          apiClient.subscriptions.$get(),
        ]);

        let totalCustomers = 0;
        let activeSubscriptions = 0;
        let monthlyRecurringRevenue = 0;
        let currency = session?.merchant?.defaultCurrency || "USD"; // Default currency with merchant fallback

        if (customersResponse.ok) {
          const customersData = await customersResponse.json();
          totalCustomers = customersData.customers?.length || 0;
        }

        if (subscriptionsResponse.ok) {
          const subscriptionsData = await subscriptionsResponse.json();
          const subscriptions: SubscriptionForMRR[] =
            subscriptionsData.subscriptions || [];

          // Calculate active subscriptions and MRR
          for (const sub of subscriptions) {
            const status = getSubscriptionStatus(sub);
            if (status === "active") {
              activeSubscriptions++;
              monthlyRecurringRevenue += calculateMRRContribution(sub);
            }
          }

          // Get currency from first subscription if available, with merchant fallback
          if (subscriptions.length > 0 && subscriptions[0].price?.currency) {
            currency = subscriptions[0].price.currency;
          } else if (!subscriptions.length) {
            // If no subscriptions, use merchant default currency
            currency = session?.merchant?.defaultCurrency || "USD";
          }
        }

        // Calculate additional metrics
        const averageRevenuePerUser =
          activeSubscriptions > 0
            ? Math.round(monthlyRecurringRevenue / activeSubscriptions)
            : 0;

        const calculatedMetrics = {
          totalCustomers,
          activeSubscriptions,
          monthlyRecurringRevenue,
          averageRevenuePerUser,
          currency,
        };

        setMetrics(calculatedMetrics);
        return calculatedMetrics;
      } catch (error) {
        console.error("Error fetching dashboard metrics:", error);
        const fallbackMetrics = {
          totalCustomers: 0,
          activeSubscriptions: 0,
          monthlyRecurringRevenue: 0,
          averageRevenuePerUser: 0,
          currency: session?.merchant?.defaultCurrency || "USD",
        };
        setMetrics(fallbackMetrics);
        return fallbackMetrics;
      } finally {
        setMetricsLoading(false);
      }
    };

    const fetchPaymentsData = async (): Promise<void> => {
      try {
        setPaymentsLoading(true);

        // Fetch payments and recent activity data
        const [paymentsResponse, subscriptionsResponse, invoicesResponse] =
          await Promise.all([
            apiClient.payments.$get(),
            apiClient.subscriptions.$get(),
            apiClient.invoices.$get(),
          ]);

        // Process payments data
        if (paymentsResponse.ok) {
          const paymentsData = await paymentsResponse.json();
          const payments: Payment[] =
            paymentsData.payments?.map((payment: Record<string, unknown>) => ({
              id: String(payment.id),
              amountCents: Number(payment.amountCents) || 0,
              currency:
                String(payment.currency) ||
                session?.merchant?.defaultCurrency ||
                "USD",
              status: String(payment.status) || "unknown",
              refundStatus: (payment.refundStatus as string | null) ?? null,
              refundedAmountCents: Number(payment.refundedAmountCents || 0),
              createdAt: new Date(String(payment.createdAt)),
              // Use the correct field names from the updated payment API
              customerName: String(payment.customerName || ""),
              invoiceNumber: String(payment.customerInvoiceNumber || "N/A"),
              invoiceId: String(payment.invoiceId || ""),
              // Related entity information
              subscriptionId: String(payment.subscriptionId || ""),
              subscriptionStableId: String(payment.subscriptionStableId || ""),
              planId: String(payment.planId || ""),
              planName: String(payment.planName || ""),
            })) || [];

          setRecentPayments(payments.slice(0, 10)); // Show last 10 payments

          // Build chart data for the selected time range, with zero-filled days
          const formatDateKey = (date: Date): string => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");
            return `${year}-${month}-${day}`;
          };

          const endDate = new Date();
          endDate.setHours(0, 0, 0, 0);
          const startDate = new Date(endDate);
          startDate.setDate(endDate.getDate() - (selectedTimeRange - 1));

          // Initialize map with all days in range set to zero
          const chartDataMap = new Map<
            string,
            { amount: number; count: number }
          >();
          for (
            let d = new Date(startDate);
            d.getTime() <= endDate.getTime();
            d.setDate(d.getDate() + 1)
          ) {
            chartDataMap.set(formatDateKey(d), { amount: 0, count: 0 });
          }

          // Aggregate payments that fall within the range
          for (const payment of payments) {
            const createdAt = new Date(payment.createdAt);
            if (
              createdAt.getTime() < startDate.getTime() ||
              createdAt.getTime() > endDate.getTime() + 24 * 60 * 60 * 1000 - 1
            ) {
              continue;
            }
            const key = formatDateKey(createdAt);
            if (chartDataMap.has(key)) {
              const existing = chartDataMap.get(key)!;
              chartDataMap.set(key, {
                amount: existing.amount + payment.amountCents,
                count: existing.count + 1,
              });
            }
          }

          const chartData: PaymentChartData[] = Array.from(
            chartDataMap.entries()
          )
            .map(([date, data]) => ({
              date,
              amount: data.amount,
              count: data.count,
            }))
            .sort((a, b) => a.date.localeCompare(b.date));

          setPaymentChartData(chartData);
        }

        // Process recent activity
        const activities: RecentActivity[] = [];

        if (subscriptionsResponse.ok) {
          const subscriptionsData = await subscriptionsResponse.json();
          const recentSubscriptions =
            subscriptionsData.subscriptions
              ?.slice(0, 5)
              .map((sub: Record<string, unknown>) => {
                const recurringPrice = Number(
                  (sub.price as Record<string, unknown>)?.recurringPrice
                );
                const customerName = String(
                  (sub.customer as Record<string, unknown>)?.name || ""
                );
                const planName = String(
                  (sub.plan as Record<string, unknown>)?.name || ""
                );
                return {
                  id: String(sub.id),
                  type: "subscription" as const,
                  title: `New subscription`,
                  subtitle: `${customerName || "Unknown Customer"}${planName ? ` - ${planName}` : ""}`,
                  // Only show amount if there's a meaningful recurring price
                  amount: recurringPrice > 0 ? recurringPrice : undefined,
                  currency:
                    String((sub.price as Record<string, unknown>)?.currency) ||
                    session?.merchant?.defaultCurrency ||
                    "USD",
                  timestamp: new Date(String(sub.createdAt)),
                  status: "success" as const,
                  planName: planName,
                };
              }) || [];
          activities.push(...recentSubscriptions);
        }

        if (invoicesResponse.ok) {
          const invoicesData = await invoicesResponse.json();
          const recentInvoices =
            invoicesData.invoices
              ?.slice(0, 5)
              .map((invoice: Record<string, unknown>) => {
                const customerName = String(
                  (invoice.customer as Record<string, unknown>)?.name || ""
                );
                const planName = String(
                  (
                    (invoice.subscription as Record<string, unknown>)
                      ?.plan as Record<string, unknown>
                  )?.name || ""
                );
                return {
                  id: String(invoice.id),
                  type: "invoice" as const,
                  title: `Invoice ${invoice.customerInvoiceNumber}`,
                  subtitle: `${customerName || "Unknown Customer"}`,
                  amount: Number(invoice.totalAmountCents) || 0,
                  currency:
                    String(invoice.currency) ||
                    session?.merchant?.defaultCurrency ||
                    "USD",
                  timestamp: new Date(String(invoice.createdAt)),
                  status:
                    invoice.status === "paid"
                      ? ("success" as const)
                      : ("pending" as const),
                  planName: planName,
                };
              }) || [];
          activities.push(...recentInvoices);
        }

        // Sort by timestamp and take the most recent
        activities.sort(
          (a: RecentActivity, b: RecentActivity) =>
            b.timestamp.getTime() - a.timestamp.getTime()
        );
        setRecentActivity(activities.slice(0, 6));
      } catch (error) {
        console.error("Error fetching payments data:", error);
      } finally {
        setPaymentsLoading(false);
      }
    };

    const loadDashboardData = async () => {
      if (!isPending && session?.user?.id) {
        const items = await getOnboardingItems();
        setOnboardingItems(items);

        // Fetch all dashboard data
        await Promise.all([fetchDashboardMetrics(), fetchPaymentsData()]);
      }
    };

    loadDashboardData();
  }, [session, isPending, router, selectedTimeRange]);

  // Show loading state while session is being fetched
  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">Loading...</div>
      </div>
    );
  }

  const completedItems = onboardingItems.filter((i) => i.completed).length;
  const totalItems = onboardingItems.length;
  const isOnboardingComplete = completedItems === totalItems;

  const getActivityIcon = (type: string) => {
    switch (type) {
      case "subscription":
        return <CreditCard className="h-4 w-4" />;
      case "invoice":
        return <FileText className="h-4 w-4" />;
      case "payment":
        return <DollarSign className="h-4 w-4" />;
      case "customer":
        return <User className="h-4 w-4" />;
      default:
        return <Activity className="h-4 w-4" />;
    }
  };

  const getPaymentStatusColor = (status: string) => {
    switch (status) {
      case "succeeded":
        return "text-green-600 bg-green-100";
      case "pending":
        return "text-yellow-600 bg-yellow-100";
      case "failed":
        return "text-red-600 bg-red-100";
      default:
        return "text-gray-600 bg-gray-100";
    }
  };

  return (
    <PageContent title="Dashboard">
      {/* Revenue Metrics */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card className="border-0 shadow-sm bg-gradient-to-br from-blue-50 to-indigo-50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Monthly Recurring Revenue
            </CardTitle>
            <div className="h-8 w-8 rounded-lg bg-blue-100 flex items-center justify-center">
              <DollarSign className="h-4 w-4 text-blue-600" />
            </div>
          </CardHeader>
          <CardContent>
            {metricsLoading ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <div className="space-y-1">
                <div className="text-2xl font-bold text-gray-900">
                  {formatCurrency(
                    metrics.monthlyRecurringRevenue,
                    metrics.currency
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center text-xs text-muted-foreground">
                    <TrendingUp className="mr-1 h-3 w-3" />
                    Recurring revenue
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm bg-gradient-to-br from-green-50 to-emerald-50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active Subscriptions
            </CardTitle>
            <div className="h-8 w-8 rounded-lg bg-green-100 flex items-center justify-center">
              <CreditCard className="h-4 w-4 text-green-600" />
            </div>
          </CardHeader>
          <CardContent>
            {metricsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="space-y-1">
                <div className="text-2xl font-bold text-gray-900">
                  {metrics.activeSubscriptions.toLocaleString()}
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center text-xs text-muted-foreground">
                    <Activity className="mr-1 h-3 w-3" />
                    Active subscriptions
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm bg-gradient-to-br from-purple-50 to-violet-50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Customers
            </CardTitle>
            <div className="h-8 w-8 rounded-lg bg-purple-100 flex items-center justify-center">
              <User className="h-4 w-4 text-purple-600" />
            </div>
          </CardHeader>
          <CardContent>
            {metricsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="space-y-1">
                <div className="text-2xl font-bold text-gray-900">
                  {metrics.totalCustomers.toLocaleString()}
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center text-xs text-muted-foreground">
                    <Users className="mr-1 h-3 w-3" />
                    Total customers
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm bg-gradient-to-br from-orange-50 to-red-50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Avg. Revenue Per User
            </CardTitle>
            <div className="h-8 w-8 rounded-lg bg-orange-100 flex items-center justify-center">
              <Target className="h-4 w-4 text-orange-600" />
            </div>
          </CardHeader>
          <CardContent>
            {metricsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="space-y-1">
                <div className="text-2xl font-bold text-gray-900">
                  {formatCurrency(
                    metrics.averageRevenuePerUser,
                    metrics.currency
                  )}
                </div>
                <div className="flex items-center text-xs text-muted-foreground">
                  <TrendingUp className="mr-1 h-3 w-3" />
                  Average per user
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Onboarding Section - Show prominently if not complete */}
      {!isOnboardingComplete && onboardingItems.length > 0 && (
        <Card className="border border-blue-200 bg-gradient-to-r from-blue-25 to-slate-25 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                  <CheckCircle className="h-5 w-5 text-blue-600" />
                  Complete Your Setup
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Get started with these essential steps
                </p>
              </div>
              <Badge
                variant="outline"
                className="border-blue-200 text-blue-700 bg-blue-50"
              >
                {completedItems} of {totalItems} completed
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid gap-4 md:grid-cols-3">
              {onboardingItems.map((item) => (
                <div
                  key={item.id}
                  onClick={item.completed ? undefined : item.action}
                  className={`flex items-center gap-4 p-4 rounded-lg border transition-all duration-200 ${
                    item.completed
                      ? "border-green-200 bg-green-50/70"
                      : "border-gray-200 bg-white hover:border-blue-200 hover:shadow-sm cursor-pointer"
                  }`}
                >
                  <div
                    className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                      item.completed
                        ? "bg-green-500 text-white"
                        : "border border-blue-300 bg-blue-50"
                    }`}
                  >
                    {item.completed ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <div className="text-xs font-medium text-blue-600">
                        {onboardingItems.indexOf(item) + 1}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4
                      className={`font-medium text-sm ${
                        item.completed ? "text-green-900" : "text-gray-900"
                      }`}
                    >
                      {item.title}
                    </h4>
                    <p
                      className={`text-xs mt-0.5 ${
                        item.completed ? "text-green-700" : "text-gray-600"
                      }`}
                    >
                      {item.description}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 text-xs font-medium">
                    {item.completed ? (
                      <span className="text-green-700">Done</span>
                    ) : (
                      <>
                        <span className="text-blue-600">Setup</span>
                        <ArrowRight className="h-3 w-3 text-blue-600" />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Content Grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column - Recent Payments Table */}
        <div className="lg:col-span-2 space-y-6">
          {/* Recent Payments Table */}
          <Card className="border-0 shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <CreditCard className="h-5 w-5 text-green-600" />
                  Recent Payments
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push("/payments")}
                >
                  View All
                  <ExternalLink className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {paymentsLoading ? (
                <div className="space-y-3">
                  {[...Array(5)].map((_, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between p-4 border rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <Skeleton className="h-10 w-10 rounded" />
                        <div>
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-3 w-48 mt-1" />
                        </div>
                      </div>
                      <div className="text-right">
                        <Skeleton className="h-4 w-20" />
                        <Skeleton className="h-3 w-16 mt-1" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {recentPayments.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <CreditCard className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                      <p className="text-lg font-medium">No payments yet</p>
                      <p className="text-sm">
                        Payments will appear here once customers start
                        subscribing
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-hidden border rounded-lg">
                      <div className="grid grid-cols-6 gap-4 p-3 bg-gray-50 text-sm font-medium text-gray-600 border-b">
                        <div>Amount</div>
                        <div>Customer</div>
                        <div>Plan</div>
                        <div>Status</div>
                        <div>Invoice</div>
                        <div>Date</div>
                      </div>
                      {recentPayments.map((payment) => (
                        <div
                          key={payment.id}
                          className="grid grid-cols-6 gap-4 p-3 hover:bg-gray-50 transition-colors border-b last:border-b-0"
                        >
                          <div className="font-medium">
                            {formatCurrency(
                              payment.amountCents,
                              payment.currency ||
                                session?.merchant?.defaultCurrency ||
                                "USD"
                            )}
                          </div>
                          <div className="text-sm text-gray-600 truncate">
                            {payment.customerName || "Unknown"}
                          </div>
                          <div className="text-sm text-gray-600 truncate">
                            {payment.planName || "N/A"}
                          </div>
                          <div>
                            {payment.refundedAmountCents &&
                            payment.refundedAmountCents > 0 ? (
                              <Badge
                                variant="secondary"
                                className="text-xs bg-purple-100 text-purple-800"
                              >
                                {payment.refundStatus &&
                                payment.refundStatus !== "full"
                                  ? "partially refunded"
                                  : "refunded"}
                              </Badge>
                            ) : (
                              <Badge
                                variant="secondary"
                                className={`text-xs ${getPaymentStatusColor(payment.status)}`}
                              >
                                {payment.status}
                              </Badge>
                            )}
                          </div>
                          <div className="text-sm text-gray-600">
                            {payment.invoiceNumber &&
                            payment.invoiceNumber !== "N/A" &&
                            payment.invoiceId ? (
                              <a
                                href={`/invoices/${payment.invoiceId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block px-2 py-1 text-xs font-semibold font-mono text-gray-700 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 hover:border-gray-400 transition-colors"
                              >
                                {payment.invoiceNumber}
                              </a>
                            ) : (
                              <span className="text-gray-500">N/A</span>
                            )}
                          </div>
                          <div className="text-sm text-gray-600">
                            <LocaleAwareDate
                              date={payment.createdAt}
                              style="custom"
                              includeTime={true}
                              className="text-sm text-gray-600"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Payment Chart */}
          <Card className="border-0 shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <BarChart3 className="h-5 w-5 text-blue-600" />
                  Payment Trends (Last {selectedTimeRange} Days)
                </CardTitle>
                <div className="flex items-center gap-4">
                  <Select
                    value={selectedTimeRange.toString()}
                    onValueChange={(value) =>
                      setSelectedTimeRange(Number(value))
                    }
                  >
                    <SelectTrigger className="w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7">7d</SelectItem>
                      <SelectItem value="15">15d</SelectItem>
                      <SelectItem value="30">30d</SelectItem>
                      <SelectItem value="60">60d</SelectItem>
                      <SelectItem value="90">90d</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={selectedMetric}
                    onValueChange={(value: "volume" | "count") =>
                      setSelectedMetric(value)
                    }
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="volume">Volume</SelectItem>
                      <SelectItem value="count">Count</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {paymentsLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : paymentChartData.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <BarChart3 className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                  <p>No payment data to display</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="text-sm text-muted-foreground">
                    Daily payment{" "}
                    {selectedMetric === "volume" ? "amounts" : "counts"}
                  </div>
                  <div className="h-64">
                    <ChartContainer>
                      <BarChart
                        data={paymentChartData.map((data) => ({
                          date: new Date(data.date).toLocaleDateString(
                            "en-US",
                            {
                              month: "short",
                              day: "numeric",
                            }
                          ),
                          value:
                            selectedMetric === "volume"
                              ? data.amount / 100
                              : data.count,
                        }))}
                        margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          className="opacity-50"
                        />
                        <XAxis
                          dataKey="date"
                          axisLine={false}
                          tickLine={false}
                          className="text-xs"
                        />
                        <YAxis
                          axisLine={{ stroke: "#e5e7eb" }}
                          tickLine={false}
                          className="text-xs"
                          tickFormatter={(value) =>
                            selectedMetric === "volume"
                              ? formatCurrency(
                                  Number(value) * 100,
                                  metrics.currency || "USD"
                                )
                              : value.toString()
                          }
                        />
                        <Tooltip
                          content={({ active, payload, label }) => {
                            if (active && payload && payload.length) {
                              return (
                                <div className="rounded-lg border bg-background p-3 shadow-sm">
                                  <div className="grid gap-2">
                                    <div className="font-medium">{label}</div>
                                    {payload.map((entry, index) => (
                                      <div
                                        key={index}
                                        className="flex items-center gap-2 text-sm"
                                      >
                                        <div
                                          className="h-2 w-2 rounded-full"
                                          style={{
                                            backgroundColor: entry.color,
                                          }}
                                        />
                                        <span className="text-muted-foreground">
                                          {selectedMetric === "volume"
                                            ? "Revenue"
                                            : "Count"}
                                          :
                                        </span>
                                        <span className="font-mono">
                                          {selectedMetric === "volume"
                                            ? formatCurrency(
                                                Number(entry.value) * 100,
                                                metrics.currency || "USD"
                                              )
                                            : entry.value}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        <Bar
                          dataKey="value"
                          fill="#3b82f6"
                          radius={[4, 4, 0, 0]}
                          name={
                            selectedMetric === "volume" ? "Revenue" : "Count"
                          }
                        />
                      </BarChart>
                    </ChartContainer>
                  </div>

                  {/* Summary stats below chart */}
                  <div className="grid grid-cols-3 gap-4 pt-4 border-t">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-blue-600">
                        {selectedMetric === "volume"
                          ? formatCurrency(
                              paymentChartData.reduce(
                                (sum, data) => sum + data.amount,
                                0
                              ),
                              metrics.currency || "USD"
                            )
                          : paymentChartData
                              .reduce((sum, data) => sum + data.count, 0)
                              .toLocaleString()}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Total{" "}
                        {selectedMetric === "volume"
                          ? "Revenue"
                          : "Transactions"}
                      </div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-blue-600">
                        {
                          paymentChartData.filter(
                            (d) => d.amount > 0 || d.count > 0
                          ).length
                        }
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Days with Data
                      </div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-blue-600">
                        {selectedMetric === "volume"
                          ? formatCurrency(
                              paymentChartData.reduce(
                                (sum, data) => sum + data.amount,
                                0
                              ) / Math.max(selectedTimeRange, 1),
                              metrics.currency || "USD"
                            )
                          : Math.round(
                              paymentChartData.reduce(
                                (sum, data) => sum + data.count,
                                0
                              ) / Math.max(selectedTimeRange, 1)
                            ).toLocaleString()}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Daily Average
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Recent Activity */}
        <div className="space-y-6">
          {/* Recent Activity */}
          <Card className="border-0 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Activity className="h-5 w-5 text-blue-600" />
                Recent Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {paymentsLoading ? (
                <div className="space-y-3">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-10 w-10 rounded-full" />
                      <div className="flex-1">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-48 mt-1" />
                      </div>
                      <Skeleton className="h-4 w-16" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {recentActivity.map((activity) => (
                    <div
                      key={activity.id}
                      className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                          {getActivityIcon(activity.type)}
                        </div>
                        <div>
                          <div className="font-medium text-sm">
                            {activity.title}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {activity.subtitle}
                          </div>
                          {activity.type === "invoice" && activity.planName && (
                            <div className="text-xs text-blue-600 mt-1">
                              Plan: {activity.planName}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        {activity.amount ? (
                          <div className="font-medium text-sm">
                            {formatCurrency(
                              activity.amount,
                              activity.currency || "USD"
                            )}
                          </div>
                        ) : activity.type === "subscription" ? (
                          <div className="text-xs text-muted-foreground font-medium">
                            Setup
                          </div>
                        ) : null}
                        <div className="text-xs text-muted-foreground">
                          <LocaleAwareDate
                            date={activity.timestamp}
                            style="custom"
                            includeTime={true}
                            className="text-xs text-muted-foreground"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  {recentActivity.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground">
                      <Activity className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                      <p>No recent activity</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </PageContent>
  );
}
