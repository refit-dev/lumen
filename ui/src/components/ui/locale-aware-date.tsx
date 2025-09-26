import { useDateFormatter, useLocaleContext } from "@/lib/locale-context";
import { detectUserLocale } from "@/lib/locale";

interface LocaleAwareDateProps {
  date: string | Date | null;
  style?: "short" | "medium" | "long" | "full" | "custom";
  includeTime?: boolean;
  fallback?: string;
  className?: string;
}

export function LocaleAwareDate({
  date,
  style = "custom",
  includeTime = true,
  fallback = "—",
  className = "font-medium",
}: LocaleAwareDateProps) {
  const dateFormatter = useDateFormatter();
  const { merchantCountry, customerCountry } = useLocaleContext();

  if (!date) {
    return <div className={className}>{fallback}</div>;
  }

  let formattedDate: string;

  if (style === "custom") {
    // Custom format: "Aug 7, 2025, <time>"
    const dateObj = typeof date === "string" ? new Date(date) : date;

    // Get locale context for proper formatting
    const localeContext = detectUserLocale(merchantCountry, customerCountry);

    // Format individual parts to avoid locale-specific formatting issues
    const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "short" });
    const monthName = monthFormatter.format(dateObj);

    const day = dateObj.getDate();
    const year = dateObj.getFullYear();
    const isSameYear = year === new Date().getFullYear();

    // Build date string manually to ensure consistent format (day first)
    const datePartFormatted = isSameYear
      ? `${day} ${monthName}`
      : `${day} ${monthName} ${year}`;

    if (includeTime) {
      // Format time part with locale-aware 12/24 hour format
      const timeOptions: Intl.DateTimeFormatOptions = {
        hour: "numeric",
        minute: "2-digit",
        hour12: localeContext.timeFormat === "12",
      };
      const timePart = new Intl.DateTimeFormat(
        localeContext.locale,
        timeOptions
      ).format(dateObj);
      formattedDate = isSameYear
        ? `${datePartFormatted} ${timePart}`
        : `${datePartFormatted}, ${timePart}`;
    } else {
      formattedDate = datePartFormatted;
    }
  } else {
    // Use existing formatting for other styles
    formattedDate = dateFormatter.formatDate(date, { style, includeTime });
  }

  return <div className={className}>{formattedDate}</div>;
}

export function LocaleAwareDateLegacy({
  date,
  fallback = "—",
  className = "font-medium",
}: {
  date: string | Date | null;
  fallback?: string;
  className?: string;
}) {
  const dateFormatter = useDateFormatter();

  if (!date) {
    return <div className={className}>{fallback}</div>;
  }

  const formattedDate = dateFormatter.formatDateLegacy(date);

  return <div className={className}>{formattedDate}</div>;
}
