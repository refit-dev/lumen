import * as React from "react";
import { cn } from "@/lib/utils";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
} from "recharts";

interface ChartContainerProps {
  children: React.ReactElement;
  className?: string;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{
    dataKey: string;
    value: string | number;
    color: string;
  }>;
  label?: string;
}

interface ChartLegendProps {
  payload?: Array<{
    value: string;
    color: string;
  }>;
}

const ChartContainer = React.forwardRef<HTMLDivElement, ChartContainerProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <div ref={ref} className={cn("w-full h-full", className)} {...props}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    );
  }
);
ChartContainer.displayName = "ChartContainer";

const ChartTooltip = React.forwardRef<HTMLDivElement, ChartTooltipProps>(
  ({ active, payload, label }, ref) => {
    if (active && payload && payload.length) {
      return (
        <div
          ref={ref}
          className="rounded-lg border bg-background p-2 shadow-sm"
        >
          <div className="grid gap-2">
            <div className="font-medium">{label}</div>
            {payload.map((entry, index) => (
              <div key={index} className="flex items-center gap-2 text-sm">
                <div
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                <span className="text-muted-foreground">{entry.dataKey}:</span>
                <span className="font-mono">{entry.value}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return null;
  }
);
ChartTooltip.displayName = "ChartTooltip";

const ChartLegend = React.forwardRef<HTMLDivElement, ChartLegendProps>(
  ({ payload }, ref) => {
    return (
      <div ref={ref} className="flex items-center justify-center gap-4 pt-4">
        {payload?.map((entry, index) => (
          <div key={index} className="flex items-center gap-2 text-sm">
            <div
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span>{entry.value}</span>
          </div>
        ))}
      </div>
    );
  }
);
ChartLegend.displayName = "ChartLegend";

export {
  ChartContainer,
  ChartTooltip,
  ChartLegend,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  ResponsiveContainer,
};
