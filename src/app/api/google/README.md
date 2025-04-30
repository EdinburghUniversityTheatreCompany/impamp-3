# Google API Security Implementation

This directory contains server-side endpoints for securely interacting with Google APIs with minimal exposure of sensitive keys to clients.

## Security Approach

The implementation provides API configuration through a controlled server endpoint:

1. **API Keys configuration through server**: Google API keys are provided through a server endpoint rather than directly in client code.
2. **API Key restrictions**: The API key should have strict Google Cloud Console restrictions:
   - HTTP Referrer restrictions to prevent use on unauthorized domains
   - API usage limitations to restrict which Google services can be accessed
   - Quota limits to prevent abuse

## Implementation Notes

For the Google Picker API, there are some specific limitations:

- Google's Picker API requires a developer key (API key) to be provided directly to the client-side library
- Since this is Google's design, we're mitigating security risks by:
  1. Keeping the API key's scope strictly limited to only the required APIs
  2. Adding HTTP referrer restrictions in Google Cloud Console to limit where the key can be used
  3. Rotating keys if any suspicious activity is detected
  4. Using environment variables instead of hardcoding keys

## Files

- `picker-config/route.ts`: Provides the necessary configuration for Google Picker API through a secure endpoint

## How It Works

1. Client requests configuration from our secure endpoint 
2. Server validates the request and returns the minimal configuration needed
3. Client uses this configuration to create a picker
4. All interactions between the client and Google services are authenticated with the user's OAuth token

This approach, while not perfect due to Google's API requirements, provides significantly better security than hardcoding API keys in client code.

## Security Best Practices

When working with the Google Picker API, always:

1. Set HTTP referrer restrictions in Google Cloud Console
2. Limit the API key to only the needed API services
3. Monitor API usage for unexpected spikes or patterns
4. Rotate keys periodically and immediately if any suspicious activity is detected
