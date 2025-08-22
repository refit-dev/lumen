# Better Auth Lumen Plugin

A Better Auth plugin that automatically creates free subscriptions when users sign up or log in via email or social providers.

## Installation

```bash
npm install # This is a local package in the monorepo
```

## Usage

### Basic Usage

```typescript
import { betterAuth } from "better-auth";
import { LumenPlugin } from "@getlumen/better-auth";

export const auth = betterAuth({
  // ... your other Better Auth configuration

  plugins: [
    LumenPlugin({
      apiUrl: process.env.API_URL || "https://api.getlumen.dev",
      apiKey: process.env.LUMEN_API_KEY!,
      enabled: true,
      prodOnly: true, // Only run in production/staging
    }),
  ],
});
```

### Advanced Usage with Callbacks

```typescript
import { betterAuth } from "better-auth";
import { LumenPlugin } from "@getlumen/better-auth";

export const auth = betterAuth({
  // ... your other Better Auth configuration

  plugins: [
    LumenPlugin({
      apiUrl: process.env.API_URL || "https://api.getlumen.dev",
      apiKey: process.env.LUMEN_API_KEY!,
      enabled: true,
      prodOnly: process.env.NODE_ENV !== "development",
      onSuccess: (user, subscription) => {
        console.log(
          `Free subscription created for ${user.email}:`,
          subscription
        );
        // Optional: Send notification, update analytics, etc.
      },
      onError: (user, error) => {
        console.error(
          `Failed to create free subscription for ${user.email}:`,
          error
        );
        // Optional: Send error notification, log to monitoring service, etc.
      },
      logger: (message, ...args) => {
        console.log(`[FreeSubscription] ${message}`, ...args);
      },
    }),
  ],
});
```

### Integration with Other Plugins

If you have other plugins, you can combine them:

```typescript
import { betterAuth } from "better-auth";
import { LumenPlugin } from "@getlumen/better-auth";
import { someOtherPlugin } from "some-other-plugin";

export const auth = betterAuth({
  // ... your other Better Auth configuration

  plugins: [
    someOtherPlugin(),
    LumenPlugin({
      apiUrl: process.env.API_URL || "https://api.getlumen.dev",
      apiKey: process.env.LUMEN_API_KEY!,
      enabled: true,
      prodOnly: true,
    }),
  ],
});
```

## Configuration Options

| Option      | Type       | Default                    | Description                                                        |
| ----------- | ---------- | -------------------------- | ------------------------------------------------------------------ |
| `apiUrl`    | `string`   | `https://api.getlumen.dev` | The base URL of your API service                                   |
| `apiKey`    | `string`   | Required                   | API key for authenticating with the subscription service           |
| `enabled`   | `boolean`  | `true`                     | Whether the plugin is enabled                                      |
| `prodOnly`  | `boolean`  | `false`                    | Whether to only run in production/staging environments             |
| `onSuccess` | `function` | Optional                   | Callback function called when subscription is created successfully |
| `onError`   | `function` | Optional                   | Callback function called when subscription creation fails          |
| `logger`    | `function` | `console.log`              | Custom logger function for debugging                               |

## How It Works

1. The plugin hooks into the Better Auth `after` hook with a matcher
2. It checks if the current request is a sign-in endpoint (email login or social callback)
3. If a new session is created, it automatically calls the `/v1/subscriptions/create-free-subscription` endpoint
4. The subscription is created with the user's email, name, and ID
5. Success/error callbacks are triggered accordingly

## Environment Variables

Make sure to set these environment variables:

```bash
API_URL=https://api.getlumen.dev  # Your API base URL (optional, defaults to production)
LUMEN_API_KEY=your-api-key-here  # Your Lumen API key (required)
```

## Error Handling

The plugin includes comprehensive error handling:

- Missing API key will skip subscription creation
- Network errors are caught and logged
- API errors are parsed and passed to the error callback
- Errors don't block user authentication (fail gracefully)

## Development vs Production

When `prodOnly` is set to `true`, the plugin will skip execution in development mode. This is useful for preventing test subscriptions from being created during development.

## Debugging

Enable debug logging by providing a custom logger:

```typescript
logger: (message, ...args) => {
  if (process.env.NODE_ENV === "development") {
    console.log(`[DEBUG] ${message}`, ...args);
  }
};
```

## Plugin ID

The plugin registers with the ID `lumen-payments` in the Better Auth system.
