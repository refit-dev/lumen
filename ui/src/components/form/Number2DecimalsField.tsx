"use client";
import { useFieldContext } from "@/hooks/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState, useEffect } from "react";
import { Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export const parseStringToCents = (value: string) => {
  // Only works for 2 decimals
  // 12 -> 1200
  // 12. -> 1200
  // 12.3 -> 1230
  // 12.34 -> 1234
  const [integer, decimals = ""] = value.split(".");
  const paddedDecimals = decimals.padEnd(2, "0");
  return parseInt(integer + paddedDecimals);
};

export const formatCentsToString = (cents: number) => {
  const dollars = Math.floor(cents / 100);
  const remainingCents = cents % 100;
  return `${dollars}.${remainingCents.toString().padStart(2, "0")}`;
};

export function Number2DecimalsField({
  label,
  subtitle,
  disabled,
  readOnly,
}: {
  label: string;
  subtitle?: string;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const field = useFieldContext<number>();
  const [displayValue, setDisplayValue] = useState(() => {
    if (field.state.value > 0) {
      return formatCentsToString(field.state.value);
    }
    if (field.state.value === 0) {
      return "0";
    }
    return "";
  });
  const isError = field.state.meta.errors.length > 0;

  // Sync displayValue with field value when it changes externally (e.g., from setFieldValue)
  useEffect(() => {
    const currentCents =
      displayValue === "" ? 0 : parseStringToCents(displayValue);

    if (currentCents !== field.state.value) {
      if (field.state.value > 0) {
        setDisplayValue(formatCentsToString(field.state.value));
      } else if (field.state.value === 0) {
        // Show "0" for zero values so users know it's free/not empty
        setDisplayValue("0");
      }
    }
  }, [field.state.value, displayValue]);

  const handleCopy = () => {
    navigator.clipboard.writeText(formatCentsToString(field.state.value));
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;

    // Allow only numbers, a single decimal point, and up to 2 decimal places
    if (value === "" || /^\d*\.?\d{0,2}$/.test(value)) {
      setDisplayValue(value);
      if (value === "") {
        field.handleChange(0);
      } else {
        const cents = parseStringToCents(value);
        field.handleChange(cents);
      }
    }
  };

  if (readOnly) {
    return (
      <div className="mb-4">
        <Label className="text-sm text-muted-foreground">{label}</Label>
        {subtitle && (
          <p className="text-sm text-muted-foreground mt-1 mb-2">{subtitle}</p>
        )}
        <div
          className={cn(
            "flex items-center justify-between p-2 rounded-md hover:bg-muted/50 cursor-pointer",
            isError && "text-red-500"
          )}
          onClick={handleCopy}
        >
          <span>
            {field.state.value ? formatCentsToString(field.state.value) : "-"}
          </span>
          <Copy className="h-4 w-4 text-muted-foreground" />
        </div>
        {isError && (
          <p className="text-sm text-red-500">
            {field.state.meta.errors.join(",")}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mb-4">
      <Label>{label}</Label>
      {subtitle && (
        <p className="text-sm text-muted-foreground mt-1 mb-2">{subtitle}</p>
      )}
      <Input
        type="text"
        inputMode="decimal"
        pattern="\d*\.?\d{0,2}"
        placeholder="0.00"
        value={displayValue}
        onChange={handleChange}
        disabled={disabled}
      />
      {isError && (
        <p className="text-sm text-red-500">
          {field.state.meta.errors.join(",")}
        </p>
      )}
    </div>
  );
}
