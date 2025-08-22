import { useFieldContext } from "@/hooks/form";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, ChevronsUpDown, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

export function Dropdown({
  label,
  options,
  placeholder = "Select an option",
  defaultValue,
  searchEnabled = false,
  disabled,
  readOnly,
}: {
  label: string;
  options: {
    label: string;
    value: string;
  }[];
  placeholder?: string;
  defaultValue?: string;
  searchEnabled?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const field = useFieldContext<string>();
  const isError = field.state.meta.errors.length > 0;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (defaultValue && !field.state.value) {
      field.handleChange(defaultValue);
    }
  }, [defaultValue, field.state.value, field]);

  const handleCopy = () => {
    const selectedOption = options.find(
      (opt) => opt.value === field.state.value
    );
    navigator.clipboard.writeText(selectedOption?.label || field.state.value);
  };

  if (readOnly) {
    const selectedOption = options.find(
      (opt) => opt.value === field.state.value
    );
    return (
      <div className="space-y-2">
        <Label className="text-sm text-muted-foreground">{label}</Label>
        <div
          className={cn(
            "flex items-center justify-between p-2 rounded-md hover:bg-muted/50 cursor-pointer",
            isError && "text-red-500"
          )}
          onClick={handleCopy}
        >
          <span>{selectedOption?.label || "-"}</span>
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

  if (searchEnabled) {
    return (
      <div className="space-y-2 mb-2">
        <Label>{label}</Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              disabled={disabled}
              className={cn(
                "w-full justify-between",
                !field.state.value && "text-muted-foreground",
                isError && "border-red-300 focus-visible:ring-red-300"
              )}
            >
              {field.state.value
                ? options.find((option) => option.value === field.state.value)
                    ?.label
                : placeholder}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-full p-0" align="start">
            <Command
              filter={(value, search) => {
                if (!search) return 1;
                return value.toLowerCase().includes(search.toLowerCase())
                  ? 1
                  : 0;
              }}
            >
              <CommandInput placeholder={`Search ${label.toLowerCase()}...`} />
              <CommandList>
                <CommandEmpty>No option found.</CommandEmpty>
                <CommandGroup>
                  {options.map((option) => (
                    <CommandItem
                      key={option.value}
                      value={option.label}
                      onSelect={() => {
                        field.handleChange(option.value);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          field.state.value === option.value
                            ? "opacity-100"
                            : "opacity-0"
                        )}
                      />
                      {option.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {isError && (
          <p className="text-sm text-red-500">
            {field.state.meta.errors.join(",")}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select
        value={field.state.value}
        onValueChange={field.handleChange}
        disabled={disabled}
      >
        <SelectTrigger
          className={isError ? "border-red-300 focus-visible:ring-red-300" : ""}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isError && (
        <p className="text-sm text-red-500">
          {field.state.meta.errors.join(",")}
        </p>
      )}
    </div>
  );
}
