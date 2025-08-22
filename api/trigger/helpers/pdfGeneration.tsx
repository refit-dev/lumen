/** @jsxImportSource react */
// ^ we need this because otherwise JSX gets parsed with hono/jsx

import { Font } from "@react-pdf/renderer";
import { triggerEnv } from "../trigger-env";
import path from "path";
import fs from "fs";

// Helper function to find the correct fonts directory
function getFontsDirectory(): string {
  const possiblePaths = [
    // Bundled environment (both dev and production) - additionalFiles copies maintaining relative path
    path.join(process.cwd(), "trigger/assets/fonts/Geist/static"),
    // Fallback - relative to this file
    path.resolve(__dirname, "../assets/fonts/Geist/static"),
  ];

  for (const fontsPath of possiblePaths) {
    const testFontPath = path.join(fontsPath, "Geist-Regular.ttf");
    console.log(`Checking font path: ${testFontPath}`);

    if (fs.existsSync(testFontPath)) {
      console.log(`Found fonts at: ${fontsPath}`);
      return fontsPath;
    }
  }

  throw new Error(
    `Could not find Geist fonts in any of these locations: ${possiblePaths.join(", ")}`
  );
}

// Get the correct fonts directory

// The fonts are not available in the EB environment - they are only available in the Trigger.dev
// worker and local dev. But we import from this file in the API server bundle, so we need to guard
// against that so the import doesn't crash the app.
// To do this, we'll only throw if we are actually in the Trigger.dev worker or local dev.
if (
  triggerEnv.NODE_ENV === "development" ||
  triggerEnv.NODE_ENV === "test" ||
  triggerEnv.IS_TRIGGER_ENV // this will be set on trigger's staging and prod envs
) {
  const fontsDir = getFontsDirectory();

  // Register Geist font for better typography
  Font.register({
    family: "Geist",
    fonts: [
      {
        src: path.join(fontsDir, "Geist-Regular.ttf"),
        fontWeight: "normal",
        fontStyle: "normal",
      },
      {
        src: path.join(fontsDir, "Geist-Bold.ttf"),
        fontWeight: "bold",
        fontStyle: "normal",
      },
      {
        src: path.join(fontsDir, "Geist-Light.ttf"),
        fontWeight: "normal",
        fontStyle: "italic",
      },
      {
        src: path.join(fontsDir, "Geist-SemiBold.ttf"),
        fontWeight: "bold",
        fontStyle: "italic",
      },
    ],
  });

  // Also register hyphenation callback for better text wrapping
  Font.registerHyphenationCallback((word) => [word]);
}
