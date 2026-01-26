# Trigger.dev Jobs Setup for Staging and Production

This document outlines how to deploy Trigger.dev jobs to staging and production environments.

## Prerequisites

Before deploying, ensure you have:

1. A Trigger.dev account and API key
2. AWS CLI configured with appropriate permissions
3. Node.js and npm/bun installed

## Environment Setup

Our infrastructure deploys secure random keys to SSM Parameter Store for each environment:

- Staging: `/lumen/staging/TRIGGER_API_ACCESS_KEY`
- Production: `/lumen/production/TRIGGER_API_ACCESS_KEY`
- Staging: `/lumen/staging/internal-api-key`
- Production: `/lumen/production/internal-api-key`

These keys are used for:
- **TRIGGER_API_ACCESS_KEY**: Authenticating Trigger.dev API calls to our API endpoints
- **INTERNAL_API_KEY**: Authenticating internal service-to-service calls (e.g., email denylist checks)

## Configuring Trigger.dev Environments

### 1. Setup Environment in Trigger.dev Dashboard

First, create a staging environment in the Trigger.dev dashboard:

1. Go to your project settings
2. Navigate to the Environments section
3. Create a new environment named "staging"

### 2. Set Environment Variables

Set the following environment variables in the Trigger.dev dashboard for each environment:

**Staging:**
```
API_URL=https://lumen-staging.pretzelai.app
TRIGGER_API_ACCESS_KEY=<value from /lumen/staging/TRIGGER_API_ACCESS_KEY in SSM>
INTERNAL_API_KEY=<value from /lumen/staging/internal-api-key in SSM>
NODE_ENV=staging
IS_TRIGGER_ENV=true
RESEND_API_KEY=<optional: for sending emails>
SLACK_WEBHOOK=<optional: for Slack notifications>
```

**Production:**
```
API_URL=https://lumen-prod.pretzelai.app
TRIGGER_API_ACCESS_KEY=<value from /lumen/production/TRIGGER_API_ACCESS_KEY in SSM>
INTERNAL_API_KEY=<value from /lumen/production/internal-api-key in SSM>
NODE_ENV=production
IS_TRIGGER_ENV=true
RESEND_API_KEY=<optional: for sending emails>
SLACK_WEBHOOK=<optional: for Slack notifications>
```

To retrieve values from SSM:

```bash
# For staging
aws ssm get-parameter --name "/lumen/staging/TRIGGER_API_ACCESS_KEY" --with-decryption --query Parameter.Value --output text
aws ssm get-parameter --name "/lumen/staging/internal-api-key" --with-decryption --query Parameter.Value --output text

# For production
aws ssm get-parameter --name "/lumen/production/TRIGGER_API_ACCESS_KEY" --with-decryption --query Parameter.Value --output text
aws ssm get-parameter --name "/lumen/production/internal-api-key" --with-decryption --query Parameter.Value --output text
```

## Deploying Jobs

### Deploying to Staging

To deploy the Trigger.dev jobs to the staging environment:

```bash
# From the api directory
npx trigger.dev@latest deploy --env staging
```

### Deploying to Production

To deploy to production:

```bash
# From the api directory
npx trigger.dev@latest deploy
```

## Testing Deployed Jobs

After deployment, you can test your jobs:

1. Go to the Trigger.dev dashboard
2. Navigate to the appropriate environment (staging/production)
3. Find your job in the list
4. Click "Run" to manually trigger the job for testing

## Troubleshooting

Common issues and solutions:

1. **Authentication Errors**: Ensure the TRIGGER_API_ACCESS_KEY environment variable in Trigger.dev matches the value in SSM Parameter Store.

2. **API Connectivity Issues**: Verify that the API_URL is correct and that the API endpoint is accessible.

3. **Missing Environment Variables**: Check that all required environment variables are set in the Trigger.dev dashboard.

4. **Deployment Failures**: Review the CLI output for any errors during deployment.

## Notes

- The jobs will run in the context of the selected environment (staging/production).
- Environment variables are environment-specific, so make sure they're configured correctly for each environment.
- Always test changes in staging before deploying to production.