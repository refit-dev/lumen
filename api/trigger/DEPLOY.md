# Deployment Plan for Trigger.dev Jobs in Staging

This document outlines the steps we've taken and the next steps required to properly set up Trigger.dev jobs in the staging environment.

## Infrastructure Changes Completed

1. **Secret Management**:
   - Added generation of a secure random `TRIGGER_API_ACCESS_KEY` in the infrastructure code
   - Stored this key in AWS SSM Parameter Store at `/lumen/staging/TRIGGER_API_ACCESS_KEY`
   - Configured the key to be securely accessible by the API service

2. **API Environment Configuration**:
   - Added `API_URL` environment variable in both staging and production environments
   - Both staging and production environments are set up to use the respective domain URLs

3. **API Authentication**:
   - Implemented a secure authentication mechanism using the SSM Parameter Store
   - Created a helper function to fetch and cache the secret key from SSM
   - Updated the `triggerAuth` middleware to use this mechanism for validating requests

## Required Steps to Complete Setup

1. **Set Up Trigger.dev Staging Environment**:
   - Create a staging environment in the Trigger.dev dashboard
   - Configure environment variables for staging:
     - `API_URL`: https://lumen-staging.pretzelai.app/v1
     - `TRIGGER_API_ACCESS_KEY`: (value from SSM Parameter Store)
     - `NODE_ENV`: staging | production

2. **Deploy Jobs to Staging**:
   - Run `npx trigger.dev@latest deploy --env staging` from the API directory
   - Verify the deployment was successful in the Trigger.dev dashboard

3. **Testing**:
   - Manually trigger each job in the staging environment through the Trigger.dev dashboard
   - Verify that the jobs can successfully authenticate with our API
   - Confirm that the expected actions are performed (e.g., invoice generation)

4. **Monitoring**:
   - Set up monitoring for the Trigger.dev jobs in the staging environment
   - Configure alerts for any job failures

## Security Considerations

- The secret key is never stored directly in code or version control
- The key is generated during infrastructure deployment and stored securely
- Only authenticated requests from Trigger.dev will be accepted by our API
- Staging and production environments use separate secret keys

## Future Improvements

- Implement CI/CD pipeline for automatic deployment of Trigger.dev jobs
- Set up a webhook integration for job status notifications
- Add more comprehensive error logging and monitoring