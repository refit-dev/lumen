import { useFieldContext } from "@/hooks/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";

export function NumberField({
  label,
  subtitle,
  disabled,
  readOnly,
  placeholder = 0,
}: {
  label: string;
  subtitle?: string;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: number | string;
}) {
  const field = useFieldContext<number>();
  const [displayValue, setDisplayValue] = useState("");
  const isError = field.state.meta.errors.length > 0;

  // Sync displayValue with field value when it changes externally (e.g., from setFieldValue)
  useEffect(() => {
    const currentNumber = displayValue === "" ? 0 : Number(displayValue);

    if (currentNumber !== field.state.value) {
      if (field.state.value && field.state.value !== 0) {
        setDisplayValue(field.state.value.toString());
      } else if (field.state.value === 0) {
        setDisplayValue("");
      }
    }
  }, [field.state.value, displayValue]);

  const handleCopy = () => {
    navigator.clipboard.writeText(field.state.value.toString());
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;

    // Allow empty string or valid numbers (including negative numbers and decimals)
    if (value === "" || /^-?\d*\.?\d*$/.test(value)) {
      setDisplayValue(value);
      if (value === "") {
        field.handleChange(0);
      } else {
        const numValue = Number(value);
        if (!isNaN(numValue)) {
          field.handleChange(numValue);
        }
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
          <span>{field.state.value || "-"}</span>
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
        inputMode="numeric"
        placeholder={placeholder.toString()}
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
