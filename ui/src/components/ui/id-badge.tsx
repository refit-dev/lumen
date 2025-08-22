import React, { useState } from "react";
import { Copy } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface IdBadgeProps {
  value: string;
  className?: string;
  isCopyable?: boolean;
}

export function IdBadge({
  value,
  className = "",
  isCopyable = true,
}: IdBadgeProps) {
  const [copyTooltipText, setCopyTooltipText] = useState("Click to copy");

  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyTooltipText("Copied!");
        setTimeout(() => setCopyTooltipText("Click to copy"), 2000);
      },
      (err) => {
        console.error("Failed to copy text: ", err);
        setCopyTooltipText("Failed to copy");
        setTimeout(() => setCopyTooltipText("Click to copy"), 2000);
      }
    );
  };

  if (!isCopyable) {
    return (
      <span className={className}>
        <code className="bg-gray-100 p-1 rounded text-sm break-all">
          {value}
        </code>
      </span>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip
        open={copyTooltipText === "Copied!" ? true : undefined}
        defaultOpen={false}
      >
        <TooltipTrigger asChild onClick={() => handleCopyToClipboard(value)}>
          <span className={`cursor-pointer ${className}`}>
            <code className="bg-gray-100 p-1 rounded text-sm break-all inline-flex items-center">
              <span className="mr-1">{value}</span>
              <Copy className="h-3 w-3 flex-shrink-0" />
            </code>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{copyTooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
