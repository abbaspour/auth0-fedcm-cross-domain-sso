/* global auth0 */
const { idpDomain, apps } = window.FEDCM_DEMO;
const app = apps[location.hostname];
const configURL = `https://${idpDomain}/fedcm/config.json`;
const redirectUri = `${location.origin}/`;
const fedcmSupported = 'IdentityCredential' in window;
// Authorization request parameters forwarded to the IdP through FedCM `params`
const AUTHORIZE_PARAMS = ['redirect_uri', 'scope', 'audience', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];

const $ = (id) => document.getElementById(id);

function log(message, data) {
  const line = document.createElement('li');
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}${data === undefined ? '' : `  ${JSON.stringify(data)}`}`;
  $('log').append(line);
  console.log(message, data ?? '');
}

if (!app) {
  document.body.textContent = `No app configured for ${location.hostname} in config.js`;
  throw new Error('unknown host');
}

// Plain constructor rather than createAuth0Client(): the latter runs checkSession() in a
// hidden iframe, which cannot see IdP cookies cross-site. FedCM replaces it here.
const client = new auth0.Auth0Client({
  domain: idpDomain,
  clientId: app.clientId,
  authorizationParams: { redirect_uri: redirectUri, scope: 'openid profile email' },
});

// Lets the SDK build a normal PKCE authorization request (and store its transaction), but
// sends the parameters through FedCM instead of navigating. The IdP returns an Auth0
// authorization code, which the SDK redeems exactly as if it had arrived on a redirect.
async function fedcmSignIn(mode) {
  let authorizeUrl;
  await client.loginWithRedirect({ openUrl: (url) => { authorizeUrl = new URL(url); } });

  const params = {};
  for (const name of AUTHORIZE_PARAMS) {
    const value = authorizeUrl.searchParams.get(name);
    if (value) params[name] = value;
  }

  log(`navigator.credentials.get() mode=${mode}`, { state: params.state, code_challenge: params.code_challenge });
  let credential;
  try {
    credential = await navigator.credentials.get({
      mediation: 'optional',
      identity: { mode, context: 'signin', providers: [{ configURL, clientId: app.clientId, params }] },
    });
  } catch (e) {
    log(`FedCM ${mode} rejected`, { name: e.name, message: e.message, error: e.error ?? e.code });
    return false;
  }

  const code = typeof credential.token === 'string' ? credential.token : credential.token?.code;
  log('FedCM credential received', { isAutoSelected: credential.isAutoSelected, code: `${code.slice(0, 6)}…` });

  const callback = new URL(params.redirect_uri);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', params.state);
  await client.handleRedirectCallback(callback.toString());
  log('Authorization code redeemed at /oauth/token (PKCE)');
  return true;
}

async function render() {
  const authenticated = await client.isAuthenticated();
  $('signed-out').hidden = authenticated;
  $('signed-in').hidden = !authenticated;
  $('login-fedcm').hidden = app.mode !== 'fedcm' || !fedcmSupported;
  if (!authenticated) return;

  const user = await client.getUser();
  const { iss, aud, sub, iat, exp } = await client.getIdTokenClaims();
  $('avatar').src = user.picture ?? '';
  $('name').textContent = user.name;
  $('email').textContent = user.email;
  $('claims').textContent = JSON.stringify({ iss, aud, sub, iat, exp }, null, 2);
}

async function logout(everywhere) {
  // Stops FedCM auto-reauthentication until the user explicitly signs in again
  if (navigator.credentials?.preventSilentAccess) await navigator.credentials.preventSilentAccess();
  if (everywhere) {
    await client.logout({ logoutParams: { returnTo: redirectUri } });
    return;
  }
  await client.logout({ openUrl: false });
  log('Logged out locally (Auth0 session untouched)');
  await render();
}

async function main() {
  $('app-name').textContent = app.name;
  $('mode').textContent = app.mode === 'fedcm'
    ? `Mode: FedCM sign-in via ${idpDomain}${fedcmSupported ? '' : ' (not supported in this browser, use redirect)'}`
    : `Mode: classic redirect login to ${idpDomain}`;
  const [otherHost, other] = Object.entries(apps).find(([host]) => host !== location.hostname);
  $('other-app').href = `https://${otherHost}/`;
  $('other-app').textContent = other.name;

  $('login-redirect').onclick = () => client.loginWithRedirect();
  $('login-fedcm').onclick = async () => { await fedcmSignIn('active'); await render(); };
  $('logout-local').onclick = () => logout(false);
  $('logout-global').onclick = () => logout(true);

  const query = new URLSearchParams(location.search);
  if (query.has('code') && query.has('state')) {
    log('Handling redirect callback');
    await client.handleRedirectCallback();
    history.replaceState({}, '', '/');
  } else if (app.mode === 'redirect') {
    log('checkSession() via same-site iframe');
    await client.checkSession();
  } else if (fedcmSupported) {
    await fedcmSignIn('passive');
  } else {
    log('FedCM not supported in this browser');
  }
  await render();
}

main().catch((e) => log('Error', { name: e.name, message: e.message, error: e.error }));
