export const randomSlug = (length: number = 3) => {
  const randomWords = words.sort(() => Math.random() - 0.5).slice(0, length);
  return randomWords.join("-");
};

export const randomCompanyName = () => {
  const shuffledWords = companyWords.sort(() => Math.random() - 0.5);
  const word1 = shuffledWords[0];
  const word2 = shuffledWords[1];
  const suffix =
    companySuffixes[Math.floor(Math.random() * companySuffixes.length)];

  return `${word1} ${word2} ${suffix}`;
};

export const randomAddress = () => {
  // Select a consistent location group
  const locationGroup =
    locationGroups[Math.floor(Math.random() * locationGroups.length)];
  const country = locationGroup.country;
  const city =
    locationGroup.cities[
      Math.floor(Math.random() * locationGroup.cities.length)
    ];
  const streetNameFormat =
    locationGroup.streetNameFormats[
      Math.floor(Math.random() * locationGroup.streetNameFormats.length)
    ];

  const streetNumber = Math.floor(Math.random() * 1000);
  const postalCode = generateRandomPostalCode(country);

  return {
    addressLine1: `${streetNumber} ${streetNameFormat}`,
    addressLine2:
      Math.random() > 0.5
        ? `${Math.floor(Math.random() * 1000)} Apt ${Math.floor(Math.random() * 1000)}`
        : "",
    city,
    postalCode,
    country,
  };
};

export const randomCustomer = () => {
  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const surname = surnames[Math.floor(Math.random() * surnames.length)];

  const address = randomAddress();

  return {
    firstName,
    surname,
    name: `${firstName} ${surname}`,
    email:
      `${firstName}.${surname}`.toLowerCase().replace(
        /[^a-zA-Z.]/g, // Remove all non-alphanumeric characters except dots (e.g. spaces, apostrophes)
        ""
      ) + `@getlumen.dev`,
    billingAddressLine1: address.addressLine1,
    billingAddressLine2: address.addressLine2,
    billingCity: address.city,
    billingPostalCode: address.postalCode,
    billingCountry: address.country,
  };
};

export const randomPlan = () => {
  const planAdjective =
    companyWords[Math.floor(Math.random() * companyWords.length)];
  const planType = [
    "Pro",
    "Premium",
    "Starter",
    "Enterprise",
    "Basic",
    "Advanced",
  ][Math.floor(Math.random() * 6)];

  const mockFeatures = [
    {
      featureName: "API Calls",
      slug: "api-calls",
      eventName: "api_call",
      isUsageBased: true,
      usagePricePerUnit: Math.floor(Math.random() * 50) + 5, // $0.05 to $0.50 in cents
      hasCreditAllowance: true,
      creditAllowanceAmount: Math.floor(Math.random() * 10000) + 1000,
      creditAllowanceRenewal: "monthly" as const,
    },
    {
      featureName: "Team Members",
      slug: "team-members",
      eventName: "team_member",
      isUsageBased: true,
      usagePricePerUnit: Math.floor(Math.random() * 500) + 100, // $1 to $5 in cents
      hasCreditAllowance: true,
      creditAllowanceAmount: Math.floor(Math.random() * 20) + 5,
      creditAllowanceRenewal: "monthly" as const,
    },
    {
      featureName: "Storage",
      slug: "storage",
      eventName: "storage_gb",
      isUsageBased: true,
      usagePricePerUnit: Math.floor(Math.random() * 20) + 5, // $0.05 to $0.20 in cents per GB
      hasCreditAllowance: true,
      creditAllowanceAmount: Math.floor(Math.random() * 500) + 100,
      creditAllowanceRenewal: "monthly" as const,
    },
    {
      featureName: "Premium Support",
      slug: "premium-support",
      eventName: "",
      isUsageBased: false,
      hasCreditAllowance: false,
    },
    {
      featureName: "Advanced Analytics",
      slug: "advanced-analytics",
      eventName: "",
      isUsageBased: false,
      hasCreditAllowance: false,
    },
    {
      featureName: "Custom Branding",
      slug: "custom-branding",
      eventName: "",
      isUsageBased: false,
      hasCreditAllowance: false,
    },
  ];

  // Pick 2-4 random features
  const selectedFeatures = mockFeatures
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.floor(Math.random() * 3) + 2);

  const monthlyPrice = Math.floor(Math.random() * 19900) + 100; // $1 to $199 in cents

  return {
    planName: `${planAdjective} ${planType}`,
    planDescription: `Perfect for growing teams who need ${planAdjective.toLowerCase()} features and reliable performance.`,
    monthlyPrice,
    yearlyPrice: Math.floor(monthlyPrice * Math.max(Math.random(), 0.7)), // Slightly cheaper yearly rate
    features: selectedFeatures,
  };
};

const generateRandomPostalCode = (country: string): string => {
  if (country === "US") {
    return `${Math.floor(Math.random() * 90000) + 10000}`;
  } else if (country === "CA") {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    return `${letters[Math.floor(Math.random() * letters.length)]}${Math.floor(Math.random() * 10)}${letters[Math.floor(Math.random() * letters.length)]} ${Math.floor(Math.random() * 10)}${letters[Math.floor(Math.random() * letters.length)]}${Math.floor(Math.random() * 10)}`;
  } else if (country === "GB") {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    return `${letters[Math.floor(Math.random() * letters.length)]}${letters[Math.floor(Math.random() * letters.length)]}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)} ${Math.floor(Math.random() * 10)}${letters[Math.floor(Math.random() * letters.length)]}${letters[Math.floor(Math.random() * letters.length)]}`;
  } else if (country === "DE") {
    return `${Math.floor(Math.random() * 90000) + 10000}`;
  } else {
    return `${Math.floor(Math.random() * 900000) + 100000}`;
  }
};

const locationGroups = [
  {
    country: "US",
    cities: [
      "New York",
      "Los Angeles",
      "Chicago",
      "Houston",
      "Phoenix",
      "Philadelphia",
      "San Antonio",
      "San Diego",
      "Dallas",
      "San Jose",
    ],
    streetNameFormats: [
      "Main St",
      "Oak Ave",
      "Maple Dr",
      "Pine Rd",
      "Cedar Ln",
      "Elm St",
      "Park Ave",
      "Washington Blvd",
      "Lake Dr",
      "River Rd",
    ],
  },
  {
    country: "GB",
    cities: ["London", "Manchester", "Birmingham", "Liverpool", "Edinburgh"],
    streetNameFormats: [
      "High St",
      "Oxford Rd",
      "Baker St",
      "Church Ln",
      "Victoria Rd",
    ],
  },
  {
    country: "DE",
    cities: ["Berlin", "Hamburg", "Munich", "Frankfurt", "Cologne"],
    streetNameFormats: [
      "Hauptstraße",
      "Bahnhofstraße",
      "Schulstraße",
      "Gartenstraße",
      "Bergstraße",
    ],
  },
];

const firstNames = [
  "James",
  "Mary",
  "John",
  "Emma",
  "Michael",
  "Olivia",
  "David",
  "Sophia",
  "Daniel",
  "Ava",
  "Robert",
  "Isabella",
  "Thomas",
  "Mia",
  "Charles",
  "Charlotte",
  "William",
  "Amelia",
  "Joseph",
  "Harper",
];

const surnames = [
  "McPotato",
  "Pretzelson",
  "Bananawitz",
  "Applebottom",
  "Cherrychild",
  "von Breadstick",
  "O'Cookie",
  "Pizzaberg",
  "Cakewell",
  "Noodleman",
  "Coffeeburg",
  "Sundaeson",
  "Donutelli",
  "Wafflington",
  "Burgermeister",
  "Pancakehouse",
  "Berlinberg",
  "Friesworthy",
  "Cupcakerton",
  "Tomatoface",
];

const words = [
  "apple",
  "banana",
  "cherry",
  "date",
  "berry",
  "pretzel",
  "berlin",
  "potato",
  "cat",
  "dog",
  "fish",
  "bird",
  "tree",
  "book",
  "desk",
  "chair",
  "table",
  "paper",
  "door",
  "window",
  "shirt",
  "pants",
  "shoes",
  "hat",
  "coat",
  "sun",
  "moon",
  "star",
  "cloud",
  "rain",
  "snow",
  "river",
  "lake",
  "ocean",
  "hill",
  "rock",
  "sand",
  "grass",
  "leaf",
  "flower",
  "truck",
  "bus",
  "train",
  "plane",
  "boat",
  "red",
  "blue",
  "green",
  "gold",
  "pink",
  "box",
  "pen",
  "bag",
  "cup",
  "bowl",
  "fork",
  "spoon",
  "plate",
  "lamp",
  "clock",
  "phone",
  "mouse",
  "key",
  "lock",
  "ball",
  "game",
  "song",
  "film",
  "cake",
  "bread",
  "milk",
  "water",
  "juice",
  "rice",
  "pizza",
  "house",
  "school",
  "shop",
  "road",
  "street",
];

const companyWords = [
  "Pickle",
  "Banana",
  "Rubber",
  "Fluffy",
  "Gigantic",
  "Squeaky",
  "Wiggly",
  "Bouncy",
  "Sparkly",
  "Fuzzy",
  "Crispy",
  "Slimy",
  "Gooey",
  "Sticky",
  "Wobbly",
  "Jelly",
  "Bubbly",
  "Zippy",
  "Snappy",
  "Peppy",
  "Happy",
  "Crazy",
  "Wacky",
  "Silly",
  "Funny",
  "Goofy",
  "Zany",
  "Loopy",
  "Nutty",
  "Quirky",
  "Whimsical",
  "Mysterious",
  "Magical",
  "Cosmic",
  "Galactic",
  "Atomic",
  "Electric",
  "Neon",
  "Turbo",
  "Super",
  "Ultra",
  "Mega",
  "Giant",
  "Tiny",
  "Mini",
  "Micro",
  "Jumbo",
  "Supreme",
  "Premium",
  "Deluxe",
];

const companySuffixes = ["Inc", "Labs", "Company", "Associates"];
