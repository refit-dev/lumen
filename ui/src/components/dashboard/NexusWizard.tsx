"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  CheckCircle,
  Info,
  AlertCircle,
  Check,
  ChevronsUpDown,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { cn } from "@/lib/utils";

// US States constant with economic nexus thresholds
const US_STATES = [
  {
    code: "AL",
    name: "Alabama",
    salesThreshold: 250000,
    transactionThreshold: null,
  },
  {
    code: "AK",
    name: "Alaska",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "AZ",
    name: "Arizona",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "AR",
    name: "Arkansas",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "CA",
    name: "California",
    salesThreshold: 500000,
    transactionThreshold: null,
  },
  {
    code: "CO",
    name: "Colorado",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "CT",
    name: "Connecticut",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "DE",
    name: "Delaware",
    salesThreshold: null,
    transactionThreshold: null,
  }, // No sales tax
  {
    code: "FL",
    name: "Florida",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "GA",
    name: "Georgia",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "HI",
    name: "Hawaii",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "ID",
    name: "Idaho",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "IL",
    name: "Illinois",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "IN",
    name: "Indiana",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "IA",
    name: "Iowa",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "KS",
    name: "Kansas",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "KY",
    name: "Kentucky",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "LA",
    name: "Louisiana",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "ME",
    name: "Maine",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "MD",
    name: "Maryland",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "MA",
    name: "Massachusetts",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "MI",
    name: "Michigan",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "MN",
    name: "Minnesota",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "MS",
    name: "Mississippi",
    salesThreshold: 250000,
    transactionThreshold: null,
  },
  {
    code: "MO",
    name: "Missouri",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "MT",
    name: "Montana",
    salesThreshold: null,
    transactionThreshold: null,
  }, // No sales tax
  {
    code: "NE",
    name: "Nebraska",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "NV",
    name: "Nevada",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "NH",
    name: "New Hampshire",
    salesThreshold: null,
    transactionThreshold: null,
  }, // No sales tax
  {
    code: "NJ",
    name: "New Jersey",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "NM",
    name: "New Mexico",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "NY",
    name: "New York",
    salesThreshold: 500000,
    transactionThreshold: 100,
  },
  {
    code: "NC",
    name: "North Carolina",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "ND",
    name: "North Dakota",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "OH",
    name: "Ohio",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "OK",
    name: "Oklahoma",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "OR",
    name: "Oregon",
    salesThreshold: null,
    transactionThreshold: null,
  }, // No sales tax
  {
    code: "PA",
    name: "Pennsylvania",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "RI",
    name: "Rhode Island",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "SC",
    name: "South Carolina",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "SD",
    name: "South Dakota",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "TN",
    name: "Tennessee",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "TX",
    name: "Texas",
    salesThreshold: 500000,
    transactionThreshold: null,
  },
  {
    code: "UT",
    name: "Utah",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "VT",
    name: "Vermont",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "VA",
    name: "Virginia",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "WA",
    name: "Washington",
    salesThreshold: 100000,
    transactionThreshold: null,
  },
  {
    code: "WV",
    name: "West Virginia",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "WI",
    name: "Wisconsin",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
  {
    code: "WY",
    name: "Wyoming",
    salesThreshold: 100000,
    transactionThreshold: 200,
  },
];

interface StateRevenue {
  state: string;
  revenue: number;
  transactions?: number;
}

interface NexusData {
  businessState: string;
  totalAnnualRevenue: number;
  hasEmployeesInOtherStates: boolean;
  statesWithEmployees: string[];
  hasPhysicalPresence: boolean;
  statesWithPhysicalPresence: string[];
  stateRevenues: StateRevenue[];
}

interface NexusWizardProps {
  onComplete: (
    nexusStates: Map<
      string,
      { physical: boolean; economic: boolean; reasons: string[] }
    >
  ) => void;
  onClose: () => void;
}

export function NexusWizard({ onComplete, onClose }: NexusWizardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [stateDropdownOpen, setStateDropdownOpen] = useState(false);
  const [data, setData] = useState<NexusData>({
    businessState: "",
    totalAnnualRevenue: 0,
    hasEmployeesInOtherStates: false,
    statesWithEmployees: [],
    hasPhysicalPresence: false,
    statesWithPhysicalPresence: [],
    stateRevenues: [],
  });

  // Convert US_STATES to dropdown options
  const stateOptions = US_STATES.filter((s) => s.salesThreshold !== null).map(
    (state) => ({
      label: state.name,
      value: state.code,
    })
  );

  const nextStep = () => setCurrentStep((prev) => prev + 1);
  const prevStep = () => setCurrentStep((prev) => prev - 1);

  const updateData = (updates: Partial<NexusData>) => {
    setData((prev) => ({ ...prev, ...updates }));
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const getRecommendedStates = () => {
    const nexusStates = new Map<
      string,
      { physical: boolean; economic: boolean; reasons: string[] }
    >();

    // Always include business state (physical nexus)
    if (data.businessState) {
      nexusStates.set(data.businessState, {
        physical: true,
        economic: true,
        reasons: ["Business headquarters"],
      });
    }

    // Include states with employees (physical nexus)
    data.statesWithEmployees.forEach((state) => {
      const existing = nexusStates.get(state) || {
        physical: false,
        economic: false,
        reasons: [],
      };
      nexusStates.set(state, {
        ...existing,
        physical: true,
        reasons: [...existing.reasons, "Employees present"],
      });
    });

    // Include states with physical presence
    data.statesWithPhysicalPresence.forEach((state) => {
      const existing = nexusStates.get(state) || {
        physical: false,
        economic: false,
        reasons: [],
      };
      nexusStates.set(state, {
        ...existing,
        physical: true,
        reasons: [
          ...existing.reasons,
          "Physical presence (property, inventory, etc.)",
        ],
      });
    });

    // Check economic nexus based on state thresholds
    data.stateRevenues.forEach(({ state, revenue, transactions }) => {
      const stateInfo = US_STATES.find((s) => s.code === state);
      if (!stateInfo) return;

      const hasEconomicNexus =
        (stateInfo.salesThreshold && revenue >= stateInfo.salesThreshold) ||
        (stateInfo.transactionThreshold &&
          transactions &&
          transactions >= stateInfo.transactionThreshold);

      if (hasEconomicNexus) {
        const existing = nexusStates.get(state) || {
          physical: false,
          economic: false,
          reasons: [],
        };
        const reasons = [...existing.reasons];

        if (stateInfo.salesThreshold && revenue >= stateInfo.salesThreshold) {
          reasons.push(
            `Sales exceed ${formatCurrency(stateInfo.salesThreshold)} threshold`
          );
        }
        if (
          stateInfo.transactionThreshold &&
          transactions &&
          transactions >= stateInfo.transactionThreshold
        ) {
          reasons.push(
            `Transactions exceed ${stateInfo.transactionThreshold} threshold`
          );
        }

        nexusStates.set(state, {
          ...existing,
          economic: true,
          reasons,
        });
      }
    });

    return nexusStates;
  };

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return (
          <div className="text-center space-y-8">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                Let&apos;s find out where you may owe sales tax
              </h2>
              <p className="text-gray-600">
                Takes ~4 minutes, no documents needed
              </p>
            </div>
            <Button onClick={nextStep} size="lg" className="px-8">
              Start
            </Button>
          </div>
        );

      case 1:
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                Where is your business headquartered?
              </h2>
              <p className="text-sm text-gray-600 mt-1">
                Your primary state of business registration
              </p>
            </div>
            <div className="space-y-2">
              <Popover
                open={stateDropdownOpen}
                onOpenChange={setStateDropdownOpen}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={stateDropdownOpen}
                    className={cn(
                      "w-full justify-between text-base h-12",
                      !data.businessState && "text-muted-foreground"
                    )}
                  >
                    {data.businessState
                      ? stateOptions.find(
                          (option) => option.value === data.businessState
                        )?.label
                      : "Select your state"}
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
                    <CommandInput placeholder="Search states..." />
                    <CommandList>
                      <CommandEmpty>No state found.</CommandEmpty>
                      <CommandGroup>
                        {stateOptions.map((option) => (
                          <CommandItem
                            key={option.value}
                            value={option.label}
                            onSelect={() => {
                              updateData({ businessState: option.value });
                              setStateDropdownOpen(false);
                              setTimeout(nextStep, 300);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                data.businessState === option.value
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
            </div>
          </div>
        );

      case 2:
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                Let&apos;s check your sales activity
              </h2>
              <p className="text-sm text-gray-600 mt-2">
                We&apos;ll ask a few questions about where you sell to determine
                if you need to collect tax in those states.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { value: 50000, label: "Under $100k" },
                { value: 300000, label: "$100k - $500k" },
                { value: 750000, label: "$500k - $1M" },
                { value: 2000000, label: "Over $1M" },
              ].map((option) => (
                <Button
                  key={option.value}
                  variant={
                    data.totalAnnualRevenue === option.value
                      ? "default"
                      : "outline"
                  }
                  size="lg"
                  className="h-auto py-4 text-center"
                  onClick={() => {
                    updateData({ totalAnnualRevenue: option.value });
                    if (option.value < 100000) {
                      // Skip to physical presence questions
                      setCurrentStep(6);
                    } else {
                      setTimeout(nextStep, 300);
                    }
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-gray-500 text-center">
              Total annual revenue across all states (estimate is fine)
            </p>
          </div>
        );

      case 3:
        // High-threshold states first (Alabama $250k, CA/NY/TX $500k)
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                First, let&apos;s check the big states
              </h2>
              <p className="text-sm text-gray-600 mt-2">
                A few states have higher thresholds before you need to collect
                tax.
              </p>
            </div>

            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <h3 className="text-sm font-medium text-amber-900 mb-2">
                  Do you have over $500k in sales to any of these states?
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  {["CA", "NY", "TX"].map((stateCode) => {
                    const state = US_STATES.find((s) => s.code === stateCode);
                    const isSelected = data.stateRevenues.some(
                      (sr) => sr.state === stateCode && sr.revenue >= 500000
                    );
                    return (
                      <Button
                        key={stateCode}
                        variant={isSelected ? "default" : "outline"}
                        className="h-auto py-3"
                        onClick={() => {
                          const existing = data.stateRevenues.filter(
                            (sr) => sr.state !== stateCode
                          );
                          if (isSelected) {
                            updateData({ stateRevenues: existing });
                          } else {
                            updateData({
                              stateRevenues: [
                                ...existing,
                                { state: stateCode, revenue: 500000 },
                              ],
                            });
                          }
                        }}
                      >
                        {state?.name}
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="text-sm font-medium text-blue-900 mb-2">
                  Do you have over $250k in sales to Alabama?
                </h3>
                <div className="flex gap-3">
                  {["Yes", "No"].map((option) => {
                    const isSelected =
                      option === "Yes"
                        ? data.stateRevenues.some(
                            (sr) => sr.state === "AL" && sr.revenue >= 250000
                          )
                        : !data.stateRevenues.some(
                            (sr) => sr.state === "AL" && sr.revenue >= 250000
                          );
                    return (
                      <Button
                        key={option}
                        variant={isSelected ? "default" : "outline"}
                        className="flex-1"
                        onClick={() => {
                          const existing = data.stateRevenues.filter(
                            (sr) => sr.state !== "AL"
                          );
                          if (option === "Yes") {
                            updateData({
                              stateRevenues: [
                                ...existing,
                                { state: "AL", revenue: 250000 },
                              ],
                            });
                          } else {
                            updateData({ stateRevenues: existing });
                          }
                        }}
                      >
                        {option}
                      </Button>
                    );
                  })}
                </div>
              </div>

              <Button onClick={nextStep} className="w-full">
                Continue
              </Button>
            </div>
          </div>
        );

      case 4:
        // Simple bubble selection for $100k+ states
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                Which states do you have over $100k in sales?
              </h2>
              <p className="text-sm text-gray-600 mt-2">
                Most states require tax collection once you exceed $100,000 in
                annual sales.
              </p>
            </div>

            <div className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <Info className="w-5 h-5 text-green-600 mt-0.5" />
                  <div className="text-sm text-green-900">
                    <p className="font-medium mb-1">
                      Select all states where you exceed $100k
                    </p>
                    <p>
                      Click to select/deselect. Only choose states where your
                      annual sales are over $100,000.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {US_STATES.filter(
                  (s) =>
                    s.salesThreshold === 100000 &&
                    s.code !== data.businessState &&
                    !["CA", "NY", "TX", "AL"].includes(s.code) // Exclude already handled states
                ).map((state) => {
                  const isSelected = data.stateRevenues.some(
                    (sr) => sr.state === state.code && sr.revenue >= 100000
                  );
                  return (
                    <Button
                      key={state.code}
                      variant={isSelected ? "default" : "outline"}
                      size="sm"
                      className="h-auto py-2 text-xs"
                      onClick={() => {
                        const existing = data.stateRevenues.filter(
                          (sr) => sr.state !== state.code
                        );
                        if (isSelected) {
                          updateData({ stateRevenues: existing });
                        } else {
                          updateData({
                            stateRevenues: [
                              ...existing,
                              { state: state.code, revenue: 100000 },
                            ],
                          });
                        }
                      }}
                    >
                      {state.name}
                    </Button>
                  );
                })}
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={nextStep}>
                  None of these
                </Button>
                <Button onClick={nextStep}>Continue</Button>
              </div>
            </div>
          </div>
        );

      case 5:
        // Physical presence - employees
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                Do you have employees or contractors in other states?
              </h2>
              <p className="text-sm text-gray-600 mt-1">
                States treat a physical footprint as automatic nexus
              </p>
            </div>
            <div className="flex gap-4">
              <Button
                variant={
                  !data.hasEmployeesInOtherStates ? "default" : "outline"
                }
                size="lg"
                className="flex-1"
                onClick={() => {
                  updateData({
                    hasEmployeesInOtherStates: false,
                    statesWithEmployees: [],
                  });
                  nextStep();
                }}
              >
                No, only in {data.businessState || "my home state"}
              </Button>
              <Button
                variant={data.hasEmployeesInOtherStates ? "default" : "outline"}
                size="lg"
                className="flex-1"
                onClick={() => {
                  updateData({ hasEmployeesInOtherStates: true });
                }}
              >
                Yes, in other states
              </Button>
            </div>

            {data.hasEmployeesInOtherStates && (
              <div className="mt-8 space-y-4">
                <h3 className="text-sm font-medium text-gray-700">
                  Which states?
                </h3>
                <div className="grid grid-cols-3 gap-2">
                  {US_STATES.filter(
                    (state) =>
                      state.code !== data.businessState &&
                      state.salesThreshold !== null
                  ).map((state) => {
                    const isSelected = data.statesWithEmployees.includes(
                      state.code
                    );
                    return (
                      <Button
                        key={state.code}
                        variant={isSelected ? "default" : "outline"}
                        size="sm"
                        className="h-auto py-2 text-xs"
                        onClick={() => {
                          const newStates = isSelected
                            ? data.statesWithEmployees.filter(
                                (s) => s !== state.code
                              )
                            : [...data.statesWithEmployees, state.code];
                          updateData({ statesWithEmployees: newStates });
                        }}
                      >
                        {state.name}
                      </Button>
                    );
                  })}
                </div>
                <Button onClick={nextStep} className="w-full">
                  Continue
                </Button>
              </div>
            )}
          </div>
        );

      case 6:
        // Physical presence - property/inventory
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                Do you have any physical property, inventory, or servers in
                other states?
              </h2>
              <p className="text-sm text-gray-600 mt-1">
                Includes offices, warehouses, or co-located server hardware —
                not virtual cloud services like AWS.
              </p>
            </div>
            <div className="flex gap-4">
              <Button
                variant={!data.hasPhysicalPresence ? "default" : "outline"}
                size="lg"
                className="flex-1"
                onClick={() => {
                  updateData({
                    hasPhysicalPresence: false,
                    statesWithPhysicalPresence: [],
                  });
                  nextStep();
                }}
              >
                No physical presence elsewhere
              </Button>
              <Button
                variant={data.hasPhysicalPresence ? "default" : "outline"}
                size="lg"
                className="flex-1"
                onClick={() => {
                  updateData({ hasPhysicalPresence: true });
                }}
              >
                Yes, in other states
              </Button>
            </div>

            {data.hasPhysicalPresence && (
              <div className="mt-8 space-y-4">
                <h3 className="text-sm font-medium text-gray-700">
                  Which states?
                </h3>
                <div className="grid grid-cols-3 gap-2">
                  {US_STATES.filter(
                    (state) =>
                      state.code !== data.businessState &&
                      state.salesThreshold !== null
                  ).map((state) => {
                    const isSelected = data.statesWithPhysicalPresence.includes(
                      state.code
                    );
                    return (
                      <Button
                        key={state.code}
                        variant={isSelected ? "default" : "outline"}
                        size="sm"
                        className="h-auto py-2 text-xs"
                        onClick={() => {
                          const newStates = isSelected
                            ? data.statesWithPhysicalPresence.filter(
                                (s) => s !== state.code
                              )
                            : [...data.statesWithPhysicalPresence, state.code];
                          updateData({ statesWithPhysicalPresence: newStates });
                        }}
                      >
                        {state.name}
                      </Button>
                    );
                  })}
                </div>
                <Button onClick={nextStep} className="w-full">
                  Continue
                </Button>
              </div>
            )}
          </div>
        );

      case 7:
        // Results
        const nexusStates = getRecommendedStates();
        const statesWithNexus = Array.from(nexusStates.entries())
          .filter(([, info]) => info.physical || info.economic)
          .sort((a, b) => a[0].localeCompare(b[0]));

        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-1">
                Your Nexus Summary
              </h2>
              <p className="text-sm text-gray-600">
                Based on your answers, you likely have nexus in these states:
              </p>
            </div>

            {statesWithNexus.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-3" />
                <p className="text-lg font-medium text-gray-900">Good news!</p>
                <p className="text-gray-600 mt-2">
                  Based on your answers, you don&apos;t appear to have nexus in
                  any additional states beyond your home state.
                </p>
                {data.totalAnnualRevenue < 100000 && (
                  <p className="text-sm text-gray-500 mt-4">
                    With revenue under $100k, you&apos;re below economic nexus
                    thresholds for all states.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {statesWithNexus.map(([stateCode, info]) => {
                  const state = US_STATES.find((s) => s.code === stateCode);
                  const isHomeState = stateCode === data.businessState;

                  return (
                    <div
                      key={stateCode}
                      className="border border-gray-200 rounded-lg p-4"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <h3 className="font-medium text-gray-900">
                              {state?.name}
                            </h3>
                            {isHomeState && (
                              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                                Home State
                              </span>
                            )}
                          </div>
                          <div className="space-y-1">
                            {info.reasons.map((reason, idx) => (
                              <div
                                key={idx}
                                className="flex items-center gap-2 text-sm text-gray-600"
                              >
                                <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
                                <span>{reason}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          {info.physical && (
                            <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
                              Physical
                            </span>
                          )}
                          {info.economic && (
                            <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded">
                              Economic
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="pt-4 space-y-3">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-start gap-2 text-sm text-gray-600">
                      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <p>
                        This is a preliminary assessment. Consult with a tax
                        professional for definitive guidance.
                      </p>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="max-w-xs">
                      Tax laws are complex and change frequently. This tool
                      provides general guidance only.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <div className="flex gap-3">
                <Button
                  onClick={() => onComplete(nexusStates)}
                  size="lg"
                  className="flex-1"
                >
                  Save Configuration
                </Button>
                <Button
                  variant="outline"
                  onClick={() => window.print()}
                  className="text-sm"
                >
                  Download Report
                </Button>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <CardContent className="p-8">
          <div className="flex items-center justify-between mb-6">
            {currentStep > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={prevStep}
                className="flex items-center gap-2"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </Button>
            )}
            <div className="flex-1 text-center">
              {currentStep > 0 && currentStep < 7 && (
                <span className="text-sm text-gray-500">
                  Step {currentStep} of 7
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700"
            >
              Cancel
            </Button>
          </div>

          {renderStep()}
        </CardContent>
      </Card>
    </div>
  );
}
