"use client";
import * as React from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  RowSelectionState,
} from "@tanstack/react-table";
import {
  ArrowUpDown,
  Calendar,
  Download,
  RefreshCw,
  Filter,
  X,
  TrendingUp,
  Users,
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { EventOutput } from "@lumen/common/validators";
import { apiClient } from "@/lib/hono-client";
import { FailedToLoadError } from "@/components/dashboard/failed-to-load-error";
import { CodeBlock } from "@/components/ui/codeblock";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePageTitle } from "@/components/dashboard/page-title-context";

const CODE_EXAMPLE = `import { sendEvent } from "@getlumen/server";

sendEvent({
  eventName: "ai-completion", // event name from the usage based feature
  eventValue: 1,
  userId: "user-id-from-your-auth-provider",
});
`;

// Quick filter options
const QUICK_FILTERS = [
  { label: "Today", value: "today", days: 0 },
  { label: "Yesterday", value: "yesterday", days: 1 },
  { label: "Last 7 days", value: "7days", days: 7 },
  { label: "Last 30 days", value: "30days", days: 30 },
  { label: "All time", value: "all", days: null },
];

interface EventFilters {
  dateRange: {
    from: Date | null;
    to: Date | null;
  };
  eventNames: string[];
  customerIds: string[];
  quickFilter: string;
}

interface EventStats {
  totalEvents: number;
  uniqueCustomers: number;
  topEventTypes: Array<{ name: string; count: number }>;
  averageEventsPerDay: number;
  totalEventValue: number;
}

interface PaginationState {
  offset: number;
  limit: number;
}

const columns: ColumnDef<EventOutput>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
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
  },
  {
    accessorKey: "eventName",
    header: () => {
      return (
        <div className="flex items-center font-semibold">
          Event Name
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </div>
      );
    },
    cell: ({ row }) => {
      return (
        <div className="font-medium">
          <Badge variant="secondary" className="font-mono text-xs">
            {row.getValue("eventName")}
          </Badge>
        </div>
      );
    },
  },
  {
    accessorKey: "eventTimestamp",
    header: () => {
      return (
        <div className="flex items-center font-semibold">
          Timestamp
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </div>
      );
    },
    cell: ({ row }) => {
      const timestamp = row.getValue("eventTimestamp") as Date;
      return (
        <div className="font-medium">
          <div className="text-sm">
            {format(timestamp, "MMM dd, yyyy 'at' HH:mm:ss")}
          </div>
          <div className="text-xs text-muted-foreground">
            {format(timestamp, "EEEE")}
          </div>
        </div>
      );
    },
  },
  {
    accessorKey: "customerId",
    header: () => {
      return (
        <div className="flex items-center font-semibold">
          Customer
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </div>
      );
    },
    cell: ({ row }) => {
      const customerId = row.getValue("customerId") as string;
      const extCustomerId = row.original.extCustomerId;

      // Show whichever ID is available, with both if both exist
      if (customerId && extCustomerId) {
        // Both IDs available - show external as primary, internal as secondary
        return (
          <div className="font-medium">
            <div className="text-sm font-mono">{extCustomerId}</div>
            <div className="text-xs text-muted-foreground">
              Lumen ID: {customerId}
            </div>
          </div>
        );
      } else if (extCustomerId) {
        // Only external ID available
        return (
          <div className="font-medium">
            <div className="text-sm font-mono">{extCustomerId}</div>
            <div className="text-xs text-muted-foreground">
              External customer ID
            </div>
          </div>
        );
      } else if (customerId) {
        // Only internal ID available
        return (
          <div className="font-medium">
            <div className="text-sm font-mono">{customerId}</div>
            <div className="text-xs text-muted-foreground">
              Lumen customer ID
            </div>
          </div>
        );
      } else {
        // No ID available
        return <div className="text-muted-foreground">-</div>;
      }
    },
  },
  {
    accessorKey: "eventValue",
    header: () => {
      return (
        <div className="flex items-center font-semibold">
          Value
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </div>
      );
    },
    cell: ({ row }) => {
      return (
        <div className="font-medium">
          {row.getValue("eventValue") ?? "-"}
          {row.original.eventString && (
            <div className="text-xs text-muted-foreground mt-1">
              &ldquo;{row.original.eventString}&rdquo;
            </div>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: "properties",
    header: "Properties",
    cell: ({ row }) => {
      const rawProperties = row.getValue("properties");

      // Handle both string and object properties
      let properties: Record<string, unknown> | null = null;
      try {
        if (typeof rawProperties === "string") {
          properties = JSON.parse(rawProperties);
        } else if (rawProperties && typeof rawProperties === "object") {
          properties = rawProperties as Record<string, unknown>;
        }
      } catch {
        // If parsing fails, treat as null
        properties = null;
      }

      if (!properties || Object.keys(properties).length === 0) {
        return <div className="text-muted-foreground">-</div>;
      }

      // Format properties as key:value pairs for display
      const formattedForDisplay = Object.entries(properties)
        .map(([key, value]) => {
          if (typeof value === "string") {
            return `${key}: "${value}"`;
          }
          return `${key}: ${value}`;
        })
        .join(", ");

      const truncatedProperties =
        formattedForDisplay.length > 50
          ? formattedForDisplay.substring(0, 50) + "..."
          : formattedForDisplay;

      // Format properties as proper JSON for copying and tooltip
      const propertiesForCopy = JSON.stringify(properties, null, 2);

      const handleCopy = () => {
        navigator.clipboard.writeText(propertiesForCopy);
        toast.success("Properties copied to clipboard");
      };

      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="font-mono text-xs max-w-[150px] truncate cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5 transition-colors"
                onClick={handleCopy}
              >
                {truncatedProperties}
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-md">
              <pre className="text-xs whitespace-pre-wrap">
                {propertiesForCopy}
              </pre>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    },
  },
];

function calculateEventStats(events: EventOutput[]): EventStats {
  if (!events.length) {
    return {
      totalEvents: 0,
      uniqueCustomers: 0,
      topEventTypes: [],
      averageEventsPerDay: 0,
      totalEventValue: 0,
    };
  }

  const uniqueCustomers = new Set();
  const eventTypeCounts: Record<string, number> = {};
  let totalEventValue = 0;

  events.forEach((event) => {
    // Count unique customers
    if (event.customerId) uniqueCustomers.add(event.customerId);
    if (event.extCustomerId) uniqueCustomers.add(event.extCustomerId);

    // Count event types
    eventTypeCounts[event.eventName] =
      (eventTypeCounts[event.eventName] || 0) + 1;

    // Sum event values
    if (event.eventValue) {
      totalEventValue += event.eventValue;
    }
  });

  // Calculate top event types
  const topEventTypes = Object.entries(eventTypeCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // Calculate average events per day
  const sortedEvents = [...events].sort(
    (a, b) =>
      new Date(a.eventTimestamp).getTime() -
      new Date(b.eventTimestamp).getTime()
  );

  const firstEvent = sortedEvents[0];
  const lastEvent = sortedEvents[sortedEvents.length - 1];

  let averageEventsPerDay = 0;
  if (firstEvent && lastEvent) {
    const daysDiff = Math.max(
      1,
      Math.ceil(
        (new Date(lastEvent.eventTimestamp).getTime() -
          new Date(firstEvent.eventTimestamp).getTime()) /
          (1000 * 60 * 60 * 24)
      )
    );
    averageEventsPerDay = Math.round(events.length / daysDiff);
  }

  return {
    totalEvents: events.length,
    uniqueCustomers: uniqueCustomers.size,
    topEventTypes,
    averageEventsPerDay,
    totalEventValue,
  };
}

export default function EventsPage() {
  const { setTitle } = usePageTitle();

  React.useEffect(() => {
    setTitle("Events");
  }, [setTitle]);

  const [pagination, setPagination] = React.useState<PaginationState>({
    offset: 0,
    limit: 50,
  });

  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

  // Filter state - this is local until user clicks Apply
  const [localFilters, setLocalFilters] = React.useState<EventFilters>({
    dateRange: { from: null, to: null },
    eventNames: [],
    customerIds: [],
    quickFilter: "all",
  });

  // Applied filters - these are sent to the backend
  const [appliedFilters, setAppliedFilters] = React.useState<EventFilters>({
    dateRange: { from: null, to: null },
    eventNames: [],
    customerIds: [],
    quickFilter: "all",
  });

  // Local states to control select component values (so they reset after selection)
  const [eventNameSelectValue, setEventNameSelectValue] =
    React.useState("placeholder");

  // State for customer search popup
  const [customerSearchOpen, setCustomerSearchOpen] = React.useState(false);
  const [customerSearchValue, setCustomerSearchValue] = React.useState("");

  // State for code example visibility
  const [showCodeExample, setShowCodeExample] = React.useState(false);

  // Fetch events with applied filters and pagination
  const {
    data: eventsResponse,
    isPending,
    isError,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: ["events", appliedFilters, pagination],
    queryFn: async () => {
      const params = new URLSearchParams();

      // Add pagination
      params.append("limit", pagination.limit.toString());
      params.append("offset", pagination.offset.toString());

      // Add filters
      if (appliedFilters.dateRange.from) {
        params.append("startDate", appliedFilters.dateRange.from.toISOString());
      }
      if (appliedFilters.dateRange.to) {
        params.append("endDate", appliedFilters.dateRange.to.toISOString());
      }
      if (appliedFilters.eventNames.length > 0) {
        params.append("eventName", appliedFilters.eventNames.join(","));
      }
      if (appliedFilters.customerIds.length > 0) {
        params.append("customerId", appliedFilters.customerIds.join(","));
      }

      const response = await apiClient.events.$get({
        query: Object.fromEntries(params),
      });
      const data = await response.json();

      if ("error" in data) {
        throw new Error(data.error);
      }

      return {
        data: data.data.map((event) => ({
          ...event,
          eventTimestamp: new Date(event.eventTimestamp),
        })),
        pagination: data.pagination,
      };
    },
  });

  // Fetch total count for stats (only with applied filters, no pagination)
  const { data: totalCount } = useQuery({
    queryKey: ["events-count", appliedFilters],
    queryFn: async () => {
      const params = new URLSearchParams();

      if (appliedFilters.dateRange.from) {
        params.append("startDate", appliedFilters.dateRange.from.toISOString());
      }
      if (appliedFilters.dateRange.to) {
        params.append("endDate", appliedFilters.dateRange.to.toISOString());
      }
      if (appliedFilters.eventNames.length > 0) {
        params.append("eventName", appliedFilters.eventNames.join(","));
      }
      if (appliedFilters.customerIds.length > 0) {
        params.append("customerId", appliedFilters.customerIds.join(","));
      }

      const response = await apiClient.events.count.$get({
        query: Object.fromEntries(params),
      });
      const data = await response.json();

      if ("error" in data) {
        throw new Error(data.error);
      }

      return data.totalCount;
    },
  });

  // Fetch unique event names independently
  const { data: uniqueEventNames = [] } = useQuery({
    queryKey: ["events-unique-event-names"],
    queryFn: async () => {
      const response = await apiClient.events["unique-event-names"].$get();
      const data = await response.json();

      if ("error" in data) {
        throw new Error(data.error);
      }

      return data.eventNames || [];
    },
  });

  // Fetch unique customer IDs independently
  const { data: uniqueCustomerIds = [] } = useQuery({
    queryKey: ["events-unique-customer-ids"],
    queryFn: async () => {
      const response = await apiClient.events["unique-customer-ids"].$get();
      const data = await response.json();

      if ("error" in data) {
        throw new Error(data.error);
      }

      return data.customerIds || [];
    },
  });

  // Calculate stats from current page data
  const stats = React.useMemo(() => {
    return calculateEventStats(eventsResponse?.data || []);
  }, [eventsResponse?.data]);

  // Fuzzy search function for customers
  const fuzzySearchCustomers = React.useMemo(() => {
    if (!customerSearchValue.trim()) {
      return uniqueCustomerIds.filter(
        (customer) => !localFilters.customerIds.includes(customer.id)
      );
    }

    const searchTerm = customerSearchValue.toLowerCase();
    return uniqueCustomerIds
      .filter((customer) => !localFilters.customerIds.includes(customer.id))
      .filter((customer) => {
        // Search across all relevant fields
        const searchableFields = [
          customer.id,
          customer.internalId,
          customer.externalId,
          customer.name,
          customer.email,
        ].filter(Boolean);

        return searchableFields.some((field) =>
          field?.toLowerCase().includes(searchTerm)
        );
      })
      .sort((a, b) => {
        // Prioritize matches that start with the search term
        const aStartsWithTerm = [
          a.id,
          a.internalId,
          a.externalId,
          a.name,
          a.email,
        ]
          .filter(Boolean)
          .some((field) => field?.toLowerCase().startsWith(searchTerm));

        const bStartsWithTerm = [
          b.id,
          b.internalId,
          b.externalId,
          b.name,
          b.email,
        ]
          .filter(Boolean)
          .some((field) => field?.toLowerCase().startsWith(searchTerm));

        if (aStartsWithTerm && !bStartsWithTerm) return -1;
        if (!aStartsWithTerm && bStartsWithTerm) return 1;

        // Then prioritize known customers over unknown
        if (a.type === "customer" && b.type === "unknown") return -1;
        if (a.type === "unknown" && b.type === "customer") return 1;

        return 0;
      });
  }, [uniqueCustomerIds, localFilters.customerIds, customerSearchValue]);

  // Handle quick filter changes (local only)
  const handleQuickFilter = (value: string) => {
    const filter = QUICK_FILTERS.find((f) => f.value === value);
    if (!filter) return;

    let dateRange = { from: null as Date | null, to: null as Date | null };

    if (filter.days !== null) {
      const now = new Date();
      const to = endOfDay(now);

      if (filter.value === "yesterday") {
        const yesterday = subDays(now, 1);
        dateRange = {
          from: startOfDay(yesterday),
          to: endOfDay(yesterday),
        };
      } else if (filter.value === "today") {
        dateRange = {
          from: startOfDay(now),
          to: to,
        };
      } else {
        dateRange = {
          from: startOfDay(subDays(now, filter.days)),
          to: to,
        };
      }
    }

    setLocalFilters((prev) => ({
      ...prev,
      quickFilter: value,
      dateRange,
    }));
  };

  // Apply filters - this triggers the backend query
  const handleApplyFilters = () => {
    setAppliedFilters(localFilters);
    setPagination((prev) => ({ ...prev, offset: 0 })); // Reset to first page
  };

  // Clear filters
  const handleClearFilters = () => {
    const clearedFilters = {
      dateRange: { from: null, to: null },
      eventNames: [],
      customerIds: [],
      quickFilter: "all",
    };
    setLocalFilters(clearedFilters);
    setAppliedFilters(clearedFilters);
    setPagination((prev) => ({ ...prev, offset: 0 })); // Reset to first page
  };

  // Handle pagination
  const handlePreviousPage = () => {
    setPagination((prev) => ({
      ...prev,
      offset: Math.max(0, prev.offset - prev.limit),
    }));
  };

  const handleNextPage = () => {
    setPagination((prev) => ({
      ...prev,
      offset: prev.offset + prev.limit,
    }));
  };

  // Handle export
  const handleExport = async () => {
    try {
      const csvData = [
        [
          "Event Name",
          "Timestamp",
          "Customer ID",
          "External Customer ID",
          "Value",
          "String",
          "Properties",
        ],
        ...(eventsResponse?.data || []).map((event) => [
          event.eventName,
          event.eventTimestamp.toISOString(),
          event.customerId || "",
          event.extCustomerId || "",
          event.eventValue?.toString() || "",
          event.eventString || "",
          event.properties ? JSON.stringify(event.properties) : "",
        ]),
      ];

      const csvContent = csvData
        .map((row) => row.map((field) => `"${field}"`).join(","))
        .join("\n");

      const blob = new Blob([csvContent], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `events-${format(new Date(), "yyyy-MM-dd")}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("Events exported successfully");
    } catch {
      toast.error("Failed to export events");
    }
  };

  const table = useReactTable<EventOutput>({
    data: eventsResponse?.data || [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true, // We handle pagination manually
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    state: {
      rowSelection,
    },
  });

  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
  const hasNextPage = eventsResponse?.pagination?.hasMore || false;
  const hasPreviousPage = pagination.offset > 0;

  return (
    <div className="space-y-6 mt-4">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Events</h1>
          <p className="text-muted-foreground">
            Track and analyze customer usage events across your platform
          </p>
        </div>
      </div>

      {/* Dashboard Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Events</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isPending ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                (totalCount || 0).toLocaleString()
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Total matching events
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Page Events</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isPending ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                stats.totalEvents.toLocaleString()
              )}
            </div>
            <p className="text-xs text-muted-foreground">Events on this page</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Top Event Type
            </CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isPending ? (
                <Skeleton className="h-8 w-20" />
              ) : stats.topEventTypes.length > 0 ? (
                <Badge variant="secondary" className="text-sm">
                  {stats.topEventTypes[0].name}
                </Badge>
              ) : (
                "-"
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {stats.topEventTypes.length > 0 && (
                <>{stats.topEventTypes[0].count} on this page</>
              )}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Page Value</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isPending ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                stats.totalEventValue.toLocaleString()
              )}
            </div>
            <p className="text-xs text-muted-foreground">Value on this page</p>
          </CardContent>
        </Card>
      </div>

      {/* Code Example Toggle */}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          onClick={() => setShowCodeExample(!showCodeExample)}
          className="flex items-center gap-2"
        >
          <Activity className="h-4 w-4" />
          {showCodeExample ? "Hide" : "Show"} Code Example
        </Button>
      </div>

      {/* Code Example */}
      {showCodeExample && (
        <CodeBlock code={CODE_EXAMPLE} language="typescript" />
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center">
            <Filter className="h-5 w-5 mr-2" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Quick Filters */}
          <div className="flex flex-wrap gap-2">
            {QUICK_FILTERS.map((filter) => (
              <Button
                key={filter.value}
                variant={
                  localFilters.quickFilter === filter.value
                    ? "default"
                    : "outline"
                }
                size="sm"
                onClick={() => handleQuickFilter(filter.value)}
              >
                {filter.label}
              </Button>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {/* Date Range */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Date Range</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    <Calendar className="mr-2 h-4 w-4" />
                    {localFilters.dateRange.from ? (
                      localFilters.dateRange.to ? (
                        <>
                          {format(localFilters.dateRange.from, "LLL dd")} -{" "}
                          {format(localFilters.dateRange.to, "LLL dd, y")}
                        </>
                      ) : (
                        format(localFilters.dateRange.from, "LLL dd, y")
                      )
                    ) : (
                      <span>Pick a date range</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarComponent
                    initialFocus
                    mode="range"
                    defaultMonth={localFilters.dateRange.from || undefined}
                    selected={{
                      from: localFilters.dateRange.from || undefined,
                      to: localFilters.dateRange.to || undefined,
                    }}
                    onSelect={(range) =>
                      setLocalFilters((prev) => ({
                        ...prev,
                        dateRange: {
                          from: range?.from || null,
                          to: range?.to || null,
                        },
                        quickFilter: "custom",
                      }))
                    }
                    numberOfMonths={2}
                  />
                </PopoverContent>
              </Popover>
            </div>

            {/* Event Names Filter */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Event Names</label>
              <Select
                value={eventNameSelectValue}
                onValueChange={(value) => {
                  if (
                    value !== "placeholder" &&
                    !localFilters.eventNames.includes(value)
                  ) {
                    setLocalFilters((prev) => ({
                      ...prev,
                      eventNames: [...prev.eventNames, value],
                    }));
                  }
                  // reset
                  setEventNameSelectValue("placeholder");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Add event name..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="placeholder" disabled>
                    Select event names
                  </SelectItem>
                  {uniqueEventNames
                    .filter((name) => !localFilters.eventNames.includes(name))
                    .map((eventName) => (
                      <SelectItem key={eventName} value={eventName}>
                        {eventName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {localFilters.eventNames.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {localFilters.eventNames.map((name) => (
                    <Badge key={name} variant="secondary" className="text-xs">
                      {name}
                      <button
                        className="ml-1 hover:text-destructive"
                        onClick={() =>
                          setLocalFilters((prev) => ({
                            ...prev,
                            eventNames: prev.eventNames.filter(
                              (n) => n !== name
                            ),
                          }))
                        }
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Customer IDs Filter */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Customer IDs</label>

              <Popover
                open={customerSearchOpen}
                onOpenChange={setCustomerSearchOpen}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={customerSearchOpen}
                    className="w-full justify-between"
                  >
                    Add customer ID...
                    <ArrowUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-full p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="Search customers by name, email, or ID..."
                      value={customerSearchValue}
                      onValueChange={setCustomerSearchValue}
                    />
                    <CommandEmpty>No customers found.</CommandEmpty>
                    <CommandGroup className="max-h-64 overflow-auto">
                      {fuzzySearchCustomers.map((customer, idx) => {
                        // Show divider between customer types and unknown IDs
                        const prevCustomer =
                          idx > 0 ? fuzzySearchCustomers[idx - 1] : null;
                        const showDivider =
                          idx > 0 &&
                          ((customer.type === "unknown" &&
                            prevCustomer?.type === "customer") ||
                            (customer.type === "customer" &&
                              prevCustomer?.type === "unknown"));

                        return (
                          <React.Fragment key={customer.id}>
                            {showDivider && (
                              <div className="border-t my-1 mx-2" />
                            )}
                            <CommandItem
                              value={customer.id}
                              onSelect={(value) => {
                                if (!localFilters.customerIds.includes(value)) {
                                  setLocalFilters((prev) => ({
                                    ...prev,
                                    customerIds: [...prev.customerIds, value],
                                  }));
                                }
                                setCustomerSearchOpen(false);
                                setCustomerSearchValue("");
                              }}
                            >
                              <div className="flex flex-col w-full">
                                {customer.type === "customer" ? (
                                  <>
                                    {/* Show external ID prominently if available, otherwise internal ID */}
                                    <span className="font-medium">
                                      {customer.externalId ||
                                        customer.internalId}
                                    </span>
                                    {/* Show secondary info in muted text */}
                                    <div className="text-xs text-muted-foreground space-y-0.5">
                                      {(customer.name || customer.email) && (
                                        <div>
                                          {customer.name && customer.email
                                            ? `${customer.name} (${customer.email})`
                                            : customer.name || customer.email}
                                        </div>
                                      )}
                                      {customer.externalId &&
                                        customer.internalId && (
                                          <div>
                                            Lumen customer id:{" "}
                                            {customer.internalId}
                                          </div>
                                        )}
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <span className="font-medium">
                                      {customer.id}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      Unknown customer
                                    </span>
                                  </>
                                )}
                              </div>
                            </CommandItem>
                          </React.Fragment>
                        );
                      })}
                    </CommandGroup>
                  </Command>
                </PopoverContent>
              </Popover>
              {localFilters.customerIds.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {localFilters.customerIds.map((id) => {
                    const customer = uniqueCustomerIds.find((c) => c.id === id);
                    const displayText =
                      customer?.type === "customer"
                        ? customer.externalId || customer.internalId
                        : id;

                    return (
                      <Badge key={id} variant="secondary" className="text-xs">
                        {displayText}
                        {(customer?.name || customer?.email) &&
                          ` (${
                            customer.name && customer.email
                              ? `${customer.name}, ${customer.email}`
                              : customer.name || customer.email
                          })`}
                        <button
                          className="ml-1 hover:text-destructive"
                          onClick={() =>
                            setLocalFilters((prev) => ({
                              ...prev,
                              customerIds: prev.customerIds.filter(
                                (c) => c !== id
                              ),
                            }))
                          }
                        >
                          ×
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-between items-center">
            <div className="flex gap-2">
              <Button onClick={handleApplyFilters}>Apply Filters</Button>
              <Button variant="outline" onClick={handleClearFilters}>
                <X className="h-4 w-4 mr-2" />
                Clear All
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isPending || isRefetching}
              >
                <RefreshCw
                  className={cn("h-4 w-4 mr-2", isRefetching && "animate-spin")}
                />
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={!eventsResponse?.data?.length}
              >
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Events Table */}
      <div className="w-full">
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
                    Array.from({ length: 10 }).map((_, index) => (
                      <TableRow key={index}>
                        {columns.map((column, i) => (
                          <TableCell key={`skeleton-${column.id || i}`}>
                            <Skeleton className="h-4 w-[100px]" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : table.getRowModel().rows?.length ? (
                    table.getRowModel().rows.map((row) => (
                      <TableRow key={row.id}>
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
                        No events found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between space-x-2 py-4">
              <div className="text-sm text-muted-foreground">
                Showing {pagination.offset + 1} to{" "}
                {Math.min(
                  pagination.offset + pagination.limit,
                  pagination.offset + (eventsResponse?.data?.length || 0)
                )}
                {totalCount &&
                  ` of ${totalCount.toLocaleString()} total events`}
              </div>
              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePreviousPage}
                  disabled={!hasPreviousPage || isPending}
                >
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Previous
                </Button>
                <div className="flex items-center space-x-2 text-sm">
                  Page {currentPage}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNextPage}
                  disabled={!hasNextPage || isPending}
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
