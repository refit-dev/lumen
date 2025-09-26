/**
 * Locale utilities for date and currency formatting
 * Based on user location, merchant settings, and browser fallback
 */

// Map of country codes to their primary locales
const COUNTRY_LOCALE_MAP: Record<string, string> = {
  // English-speaking countries
  US: "en-US",
  CA: "en-CA",
  GB: "en-GB",
  AU: "en-AU",
  NZ: "en-NZ",
  IE: "en-IE",
  ZA: "en-ZA",

  // European countries
  DE: "de-DE",
  FR: "fr-FR",
  ES: "es-ES",
  IT: "it-IT",
  NL: "nl-NL",
  PT: "pt-PT",
  PL: "pl-PL",
  RU: "ru-RU",
  NO: "nb-NO",
  SE: "sv-SE",
  DK: "da-DK",
  FI: "fi-FI",
  AT: "de-AT",
  CH: "de-CH",
  BE: "nl-BE",
  CZ: "cs-CZ",
  HU: "hu-HU",
  RO: "ro-RO",
  GR: "el-GR",
  BG: "bg-BG",
  HR: "hr-HR",
  SI: "sl-SI",
  SK: "sk-SK",
  LT: "lt-LT",
  LV: "lv-LV",
  EE: "et-EE",
  MT: "mt-MT",
  CY: "el-CY",
  LU: "lb-LU",

  // Asian countries
  JP: "ja-JP",
  KR: "ko-KR",
  CN: "zh-CN",
  TW: "zh-TW",
  HK: "zh-HK",
  SG: "en-SG",
  MY: "ms-MY",
  TH: "th-TH",
  VN: "vi-VN",
  ID: "id-ID",
  PH: "en-PH",
  IN: "hi-IN",
  BD: "bn-BD",
  PK: "ur-PK",
  LK: "si-LK",
  MM: "my-MM",
  KH: "km-KH",
  LA: "lo-LA",
  MN: "mn-MN",
  KZ: "kk-KZ",
  UZ: "uz-UZ",
  KG: "ky-KG",
  TJ: "tg-TJ",
  TM: "tk-TM",
  AF: "fa-AF",
  IR: "fa-IR",
  IQ: "ar-IQ",
  SA: "ar-SA",
  AE: "ar-AE",
  QA: "ar-QA",
  BH: "ar-BH",
  KW: "ar-KW",
  OM: "ar-OM",
  YE: "ar-YE",
  JO: "ar-JO",
  SY: "ar-SY",
  LB: "ar-LB",
  IL: "he-IL",
  TR: "tr-TR",
  GE: "ka-GE",
  AM: "hy-AM",
  AZ: "az-AZ",

  // American countries
  MX: "es-MX",
  BR: "pt-BR",
  AR: "es-AR",
  CL: "es-CL",
  CO: "es-CO",
  PE: "es-PE",
  VE: "es-VE",
  EC: "es-EC",
  BO: "es-BO",
  PY: "es-PY",
  UY: "es-UY",
  GY: "en-GY",
  SR: "nl-SR",
  GF: "fr-GF",

  // African countries
  NG: "en-NG",
  KE: "en-KE",
  TZ: "en-TZ",
  UG: "en-UG",
  RW: "en-RW",
  ET: "am-ET",
  GH: "en-GH",
  SN: "fr-SN",
  CI: "fr-CI",
  CM: "fr-CM",
  MA: "ar-MA",
  DZ: "ar-DZ",
  TN: "ar-TN",
  LY: "ar-LY",
  EG: "ar-EG",
  SD: "ar-SD",
  ZM: "en-ZM",
  ZW: "en-ZW",
  BW: "en-BW",
  MZ: "pt-MZ",
  AO: "pt-AO",
  MG: "mg-MG",
  MU: "en-MU",
  SC: "en-SC",

  // Oceania
  FJ: "en-FJ",
  PG: "en-PG",
  VU: "en-VU",
  SB: "en-SB",
  NC: "fr-NC",
  PF: "fr-PF",
  WS: "en-WS",
  TO: "en-TO",
  KI: "en-KI",
  TV: "en-TV",
  NR: "en-NR",
  PW: "en-PW",
  FM: "en-FM",
  MH: "en-MH",
};

// Interface for locale context
export interface LocaleContext {
  locale: string;
  country?: string;
  dateFormat?: "DMY" | "MDY" | "YMD";
  timeFormat?: "12" | "24";
}

// Get locale from country code
export function getLocaleFromCountry(countryCode: string): string {
  return COUNTRY_LOCALE_MAP[countryCode.toUpperCase()] || "en-US";
}

// Detect user's locale with multiple fallbacks
export function detectUserLocale(
  merchantCountry?: string,
  customerCountry?: string
): LocaleContext {
  // Priority order: customer country > merchant country > browser locale > default
  let locale = "en-US";
  let country: string | undefined;

  if (customerCountry) {
    locale = getLocaleFromCountry(customerCountry);
    country = customerCountry;
  } else if (merchantCountry) {
    locale = getLocaleFromCountry(merchantCountry);
    country = merchantCountry;
  } else if (typeof window !== "undefined" && navigator.language) {
    // Use browser locale as fallback
    locale = navigator.language;
    // Try to extract country from locale (e.g., en-GB -> GB)
    const parts = locale.split("-");
    if (parts.length > 1) {
      country = parts[1];
    }
  }

  return {
    locale,
    country,
    dateFormat: getDateFormatForLocale(locale),
    timeFormat: getTimeFormatForLocale(locale),
  };
}

// Get preferred date format for locale
function getDateFormatForLocale(locale: string): "DMY" | "MDY" | "YMD" {
  const country = locale.split("-")[1];

  // Countries that use MDY format
  const mdyCountries = ["US", "CA", "PH", "FM", "PW", "MH"];
  if (mdyCountries.includes(country)) return "MDY";

  // Countries that use YMD format
  const ymdCountries = [
    "JP",
    "KR",
    "CN",
    "TW",
    "HK",
    "MN",
    "KZ",
    "KG",
    "LT",
    "HU",
  ];
  if (ymdCountries.includes(country)) return "YMD";

  // Default to DMY for most of the world
  return "DMY";
}

// Get preferred time format for locale
function getTimeFormatForLocale(locale: string): "12" | "24" {
  const country = locale.split("-")[1];

  // Countries that use 12-hour format
  const twelveHourCountries = [
    "US",
    "CA",
    "AU",
    "NZ",
    "PH",
    "EG",
    "SA",
    "IN",
    "BD",
    "PK",
    "MY",
  ];
  if (twelveHourCountries.includes(country)) return "12";

  // Default to 24-hour format
  return "24";
}

// Format date with locale awareness
export function formatDate(
  date: Date | string,
  options: {
    merchantCountry?: string;
    customerCountry?: string;
    style?: "short" | "medium" | "long" | "full";
    includeTime?: boolean;
  } = {}
): string {
  const dateObj = typeof date === "string" ? new Date(date) : date;
  const localeContext = detectUserLocale(
    options.merchantCountry,
    options.customerCountry
  );

  // Build month name in English explicitly
  const monthName = new Intl.DateTimeFormat("en-US", { month: "short" }).format(
    dateObj
  );
  const day = dateObj.getDate();
  const year = dateObj.getFullYear();
  const isSameYear = year === new Date().getFullYear();

  const datePart = isSameYear
    ? `${day} ${monthName}`
    : `${day} ${monthName} ${year}`;

  if (options.includeTime) {
    const timeOptions: Intl.DateTimeFormatOptions = {
      hour: "numeric",
      minute: "2-digit",
      hour12: localeContext.timeFormat === "12",
    };
    const timePart = new Intl.DateTimeFormat(
      localeContext.locale,
      timeOptions
    ).format(dateObj);

    return isSameYear ? `${datePart} ${timePart}` : `${datePart}, ${timePart}`;
  }

  return datePart;
}

// Get localized date format string for date-fns
export function getDateFormatString(
  merchantCountry?: string,
  customerCountry?: string,
  style: "short" | "medium" | "long" | "full" = "medium"
): string {
  const localeContext = detectUserLocale(merchantCountry, customerCountry);

  // Map format styles to date-fns format strings based on locale
  const formatMap: Record<string, Record<string, string>> = {
    DMY: {
      short: "dd/MM/yy",
      medium: "dd/MM/yyyy",
      long: "dd MMMM yyyy",
      full: "EEEE, dd MMMM yyyy",
    },
    MDY: {
      short: "MM/dd/yy",
      medium: "MM/dd/yyyy",
      long: "MMMM dd, yyyy",
      full: "EEEE, MMMM dd, yyyy",
    },
    YMD: {
      short: "yy/MM/dd",
      medium: "yyyy/MM/dd",
      long: "yyyy MMMM dd",
      full: "EEEE, yyyy MMMM dd",
    },
  };

  return formatMap[localeContext.dateFormat || "DMY"][style];
}

// React hook for locale context
export function useLocaleContext(
  merchantCountry?: string,
  customerCountry?: string
): LocaleContext {
  return detectUserLocale(merchantCountry, customerCountry);
}
