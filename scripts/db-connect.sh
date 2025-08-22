#!/bin/bash
# Script to establish an SSM tunnel to the database and configure DBeaver

# Check if we have the necessary tools
command -v aws >/dev/null 2>&1 || { echo "AWS CLI not installed. Please install it first."; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not installed. Please install it with 'brew install jq' first."; exit 1; }

# Parse arguments
ENV=$1  # staging or production
LOCAL_PORT=${2:-5433}  # default to 5433 if not specified
QUESTDB_LOCAL_PORT=9952 # Port for QuestDB console

if [ "$ENV" != "staging" ] && [ "$ENV" != "production" ]; then
  echo "Usage: ./db-connect.sh [staging|production] [local_port]"
  echo "Example: ./db-connect.sh staging 5433"
  exit 1
fi

echo "Setting up connection to $ENV database..."

# Get instance ID from SSM Parameter Store
echo "Fetching SSM instance ID..."
INSTANCE_ID=$(aws ssm get-parameter --name "/lumen/$ENV/ssm-instance-id" --query "Parameter.Value" --output text)

if [ -z "$INSTANCE_ID" ]; then
  echo "Error: Could not find SSM instance ID. Please check the parameter exists and you have proper AWS credentials configured."
  exit 1
fi

# Get database credentials from Secrets Manager
echo "Fetching database credentials from AWS Secrets Manager..."
CREDS=$(aws secretsmanager get-secret-value --secret-id "lumen/$ENV/db-credentials" --query "SecretString" --output text)

if [ -z "$CREDS" ]; then
  echo "Error: Could not retrieve database credentials. Please check your AWS credentials and secret name."
  exit 1
fi

# Parse the JSON credentials
DB_HOST=$(echo $CREDS | jq -r '.host')
DB_USER=$(echo $CREDS | jq -r '.username')
DB_PASS=$(echo $CREDS | jq -r '.password')
DB_NAME=$(echo $CREDS | jq -r '.dbname // "lumen"')

# Get QuestDB host from SSM Parameter Store
echo "Fetching QuestDB host..."
QUESTDB_HOST_IP=$(aws ssm get-parameter --name "/lumen/$ENV/QUESTDB_HOST" --query "Parameter.Value" --output text)

if [ -z "$QUESTDB_HOST_IP" ]; then
  echo "Error: Could not find QuestDB host in SSM Parameter Store (/lumen/$ENV/QUESTDB_HOST)."
  echo "Please ensure the CDK stack exports this value to SSM."
  exit 1
fi

# Construct QuestDB username
QUESTDB_USER="lumen_quest_user_$ENV"

# Fetch QuestDB password from Secrets Manager
echo "Fetching QuestDB password from AWS Secrets Manager..."
QUESTDB_PASS=$(aws secretsmanager get-secret-value --secret-id "lumen/$ENV/questdb-password" --query "SecretString" --output text)

if [ -z "$QUESTDB_PASS" ]; then
  echo "Error: Could not retrieve QuestDB password. Please check your AWS credentials and secret name (lumen/$ENV/questdb-password)."
  exit 1
fi

echo "Creating DBeaver connection configuration..."

# Create connection file for DBeaver
CONNECTION_FILE="$HOME/Downloads/lumen-$ENV-connection.xml"

# Create DBeaver connection XML - using format compatible with 'Custom -> Connections' import
cat > "$CONNECTION_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<connections>
  <connection
    name="Lumen $ENV DB"
    driver="postgres-jdbc"
    url="jdbc:postgresql://localhost:$LOCAL_PORT/$DB_NAME"
    user="$DB_USER"
    password="$DB_PASS"
    auto-commit="true"
    save-password="true"
    id="postgres-jdbc-lumen-$ENV"
    folder=""
    type="$ENV"
  />
</connections>
EOF

# Set permissions to user-only for security
chmod 600 "$CONNECTION_FILE"

echo "✅ DBeaver connection created!"
echo ""
echo "To import in DBeaver:"
echo "1. Open DBeaver"
echo "2. Select 'File' → 'Import'"
echo "3. In the import wizard, search for 'Custom' and select 'Custom'"
echo "4. Select Postgres on the next screen. Click Next."
echo "5. Browse to select the file: $CONNECTION_FILE"
echo "6. Follow the wizard to complete"
echo ""
echo "*************************************************************************"
echo "*                         !!! WARNING !!!                               *"
echo "*************************************************************************"
echo "***                                                                   ***"
echo "***  THE DBeaver CONNECTION FILE WILL BE AUTO-DELETED IN 20 SECONDS!  ***"
echo "***  Import the file into DBeaver NOW.                                ***"
echo "***                                                                   ***"
echo "***  File Location:                                                   ***"
echo "***  $CONNECTION_FILE"
echo "***                                                                   ***"
echo "*************************************************************************"
echo ""

# Start background task to delete the connection file after 20 seconds
(sleep 20 && echo "Deleting connection file: $CONNECTION_FILE" && rm -f "$CONNECTION_FILE" && echo "✅ Connection file deleted.") &

# Display QuestDB credentials if staging
if [ "$ENV" == "staging" ]; then
  echo ""
  echo "--- QuestDB Staging Credentials ---"
  echo "Username: $QUESTDB_USER"
  echo "Password: $QUESTDB_PASS"
  echo "---------------------------------"
  echo ""
fi

echo "Starting SSM sessions for port forwarding to $ENV database (Postgres: localhost:$LOCAL_PORT, QuestDB: localhost:$QUESTDB_LOCAL_PORT)..."
echo "To close the connections, press Ctrl+C in this terminal."
echo ""

# Start the SSM session for PostgreSQL port forwarding in the background
aws ssm start-session \
  --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$DB_HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}" & 

# Capture the PID of the first background process
SSM_PID_PG=$!

# Start the SSM session for QuestDB port forwarding in the background
aws ssm start-session \
  --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$QUESTDB_HOST_IP\"],\"portNumber\":[\"9000\"],\"localPortNumber\":[\"$QUESTDB_LOCAL_PORT\"]}" &

# Capture the PID of the second background process
SSM_PID_QUESTDB=$!

# Function to clean up background processes on exit
cleanup() {
    echo "
Terminating SSM sessions..."
    # Check if processes exist before killing
    if kill -0 $SSM_PID_PG 2>/dev/null; then
        kill $SSM_PID_PG
    fi
    if kill -0 $SSM_PID_QUESTDB 2>/dev/null; then
        kill $SSM_PID_QUESTDB
    fi
    echo "SSM sessions terminated."
    # Exit the main script after cleanup
    exit 0
}

# Trap Ctrl+C (SIGINT) and script exit (EXIT) to run cleanup
trap cleanup SIGINT EXIT

# Wait indefinitely, keeping the script alive while background sessions run.
# The trap will handle cleanup when Ctrl+C is pressed.
echo "Connections established. Press Ctrl+C to terminate sessions."

# Keep script alive while background jobs run. Wait for both PIDs.
# If one exits prematurely, the script will wait for the other.
wait $SSM_PID_PG 2>/dev/null
wait $SSM_PID_QUESTDB 2>/dev/null

# If wait finishes without trap (e.g., sessions closed remotely), exit cleanly.
echo "One or both SSM sessions ended."
exit 0