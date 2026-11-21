// Cognito PreSignUp trigger: confirms new self-service accounts so the demo needs
// no email-code step. It never adds groups: every self-registered user is an adopter.
// Staff and Admin roles are granted only by an administrator (admin-add-user-to-group).
export const handler = async (event) => {
  event.response.autoConfirmUser = true;
  if (event.request.userAttributes.email) event.response.autoVerifyEmail = true;
  console.log(JSON.stringify({ level: 'info', service: 'presignup', msg: 'sign-up confirmed', userPoolId: event.userPoolId }));
  return event;
};
