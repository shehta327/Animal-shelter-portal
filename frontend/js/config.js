// Filled in by infra/deploy-web.sh (IDs and URLs only - never secrets).
// The Cognito app client is a public client (no client secret), so these values are safe in the browser.
export const CONFIG = {
  apiBaseUrl: '__API_BASE_URL__',
  cognitoEndpoint: '__COGNITO_ENDPOINT__',
  cognitoClientId: '__COGNITO_CLIENT_ID__'
};
