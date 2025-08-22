export interface CurrencyOption {
  code: string;
  name: string;
  symbol: string;
}

export const STRIPE_SUPPORTED_CURRENCIES: CurrencyOption[] = [
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "GBP", name: "British Pound", symbol: "£" },
  { code: "CAD", name: "Canadian Dollar", symbol: "C$" },
  { code: "AUD", name: "Australian Dollar", symbol: "A$" },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF" },
  { code: "SEK", name: "Swedish Krona", symbol: "kr" },
  { code: "NOK", name: "Norwegian Krone", symbol: "kr" },
  { code: "DKK", name: "Danish Krone", symbol: "kr" },
  { code: "PLN", name: "Polish Zloty", symbol: "zł" },
];

export const DODO_SUPPORTED_CURRENCIES: CurrencyOption[] = [
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "INR", name: "Indian Rupee", symbol: "₹" },
];

export const getAllSupportedCurrencies = (): CurrencyOption[] => {
  // Combine both lists and remove duplicates
  const allCurrencies = [
    ...STRIPE_SUPPORTED_CURRENCIES,
    ...DODO_SUPPORTED_CURRENCIES,
  ];
  const uniqueCurrencies = allCurrencies.filter(
    (currency, index, self) =>
      index === self.findIndex((c) => c.code === currency.code)
  );
  return uniqueCurrencies;
};

export const getCurrenciesForProvider = (
  provider: "stripe" | "dodo" | "paddle" | "checkout" | "adyen" | null
): CurrencyOption[] => {
  switch (provider) {
    case "stripe":
      return STRIPE_SUPPORTED_CURRENCIES;
    case "dodo":
      return DODO_SUPPORTED_CURRENCIES;
    default:
      return getAllSupportedCurrencies();
  }
};

export const formatCurrencyOption = (currency: CurrencyOption): string => {
  return `${currency.code} - ${currency.name}`;
};
