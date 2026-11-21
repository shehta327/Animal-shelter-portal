// Sign-up / sign-in with Amazon Cognito (USER_PASSWORD_AUTH on a public app client).
// The ID token is kept in sessionStorage (cleared when the tab closes) and sent as a
// Bearer token. The role shown here is ONLY for the menu: every backend verifies the
// token signature and reads the role from the signed cognito:groups claim itself.
import { CONFIG } from './config.js';

const KEY = 'shelter.session';

async function cognito(action, body) {
  const res = await fetch(CONFIG.cognitoEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const type = String(data.__type || data.code || '').split('#').pop();
    const friendly = {
      NotAuthorizedException: 'Incorrect email or password.',
      UserNotFoundException: 'Incorrect email or password.',
      UsernameExistsException: 'An account with this email already exists.',
      InvalidPasswordException: 'Password must be at least 8 characters with upper and lower case letters and a number.',
      InvalidParameterException: 'Please check the details you entered.',
      TooManyRequestsException: 'Too many attempts. Wait a minute and try again.'
    };
    throw new Error(friendly[type] || 'Sign-in service error. Try again.');
  }
  return data;
}

function decode(token) {
  const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(part))));
}

export async function signUp({ name, email, password }) {
  await cognito('SignUp', {
    ClientId: CONFIG.cognitoClientId,
    Username: email,
    Password: password,
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'name', Value: name }]
  });
  return signIn({ email, password });
}

export async function signIn({ email, password }) {
  const data = await cognito('InitiateAuth', {
    ClientId: CONFIG.cognitoClientId,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password }
  });
  const idToken = data.AuthenticationResult && data.AuthenticationResult.IdToken;
  if (!idToken) throw new Error('Sign-in needs an extra step that this portal does not support.');
  sessionStorage.setItem(KEY, idToken);
  return currentUser();
}

export function signOut() {
  sessionStorage.removeItem(KEY);
}

export function token() {
  const t = sessionStorage.getItem(KEY);
  if (!t) return null;
  try {
    if (decode(t).exp * 1000 < Date.now() + 10000) { signOut(); return null; }
  } catch { signOut(); return null; }
  return t;
}

export function currentUser() {
  const t = token();
  if (!t) return null;
  const p = decode(t);
  const groups = p['cognito:groups'] || [];
  const role = groups.includes('Admin') ? 'admin' : groups.includes('Staff') ? 'staff' : 'adopter';
  return { sub: p.sub, email: p.email, name: p.name || p.email, role, isStaff: role !== 'adopter' };
}
