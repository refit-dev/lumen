#!/usr/bin/env bash
set -euo pipefail

# Load environment variables from .env file
ENV_FILE="api/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi

# Read the API key from .env file
STRIPE_API_KEY=$(grep "^TEST_STRIPE_SECRET_KEY=" "$ENV_FILE" | cut -d '=' -f2- | tr -d '"' | tr -d "'")
if [[ -z "$STRIPE_API_KEY" ]]; then
  echo "Error: TEST_STRIPE_SECRET_KEY not found in $ENV_FILE"
  exit 1
fi

echo "Using Stripe API key from $ENV_FILE"

# Read merchant id from command line argument, file, or fallback to 'mer_test'
MERCHANT_ID="mer_test"

# First priority: command line argument
if [[ $# -gt 0 && -n "$1" ]]; then
  MERCHANT_ID="$1"
  echo "Using merchant ID from command line: $MERCHANT_ID"
# Second priority: file
elif [[ -f /tmp/test_merchant_id.txt ]]; then
  FILE_ID=$(cat /tmp/test_merchant_id.txt | tr -d '[:space:]')
  if [[ -n "$FILE_ID" ]]; then
    MERCHANT_ID="$FILE_ID"
    echo "Using merchant ID from file: $MERCHANT_ID"
  fi
else
  echo "Using default merchant ID: $MERCHANT_ID"
fi

# Function to clean up resources
cleanup() {
  echo "Shutting down Stripe webhook listener..."
  # Kill the process and its children
  pkill -P $LISTEN_PID || true
  kill -TERM $LISTEN_PID 2>/dev/null || true

  # Make sure the process is really gone
  if ps -p $LISTEN_PID > /dev/null 2>&1; then
    echo "Forcing termination of Stripe webhook listener..."
    kill -9 $LISTEN_PID 2>/dev/null || true
  fi

  echo "Stripe webhook listener shut down."
  exit 0
}

# Define the forward URL
FORWARD_URL="localhost:8000/v1/public/webhook/$MERCHANT_ID"
echo "Forwarding webhooks to: $FORWARD_URL"

# 1. Ask Stripe CLI for the (re-used or freshly created) secret using API key
export STRIPE_WEBHOOK_SECRET=$(\
  stripe listen --api-key "$STRIPE_API_KEY" --forward-to $FORWARD_URL --print-secret
)

# 2. Persist it so any other terminal can read it
echo "$STRIPE_WEBHOOK_SECRET" > /tmp/test_webhook_secret.txt
echo "Saved secret to /tmp/test_webhook_secret.txt: $STRIPE_WEBHOOK_SECRET"

# 3. Run the listener itself in the background using API key
stripe listen --api-key "$STRIPE_API_KEY" --forward-to $FORWARD_URL &
LISTEN_PID=$!

# Register the cleanup function to run when the script receives SIGINT or SIGTERM
trap cleanup INT TERM EXIT

# 4. (optional) Also launch the app here. Comment this line out if you
#    want to start the app manually elsewhere.
# npm run dev &

# Wait for the listener process to complete
wait $LISTEN_PID