import config from './config.generated.js';
import { auth0Fetch } from './proxy.js';

const SCOPE = 'openid profile email';
// Authorization request parameters the RP may pass through FedCM `params`
const RP_AUTHORIZE_PARAMS = ['redirect_uri', 'scope', 'audience', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];
const STATE_COOKIE = '__Host-fedcm_state';
const CORS_PATHS = new Set(['/fedcm/assertion', '/fedcm/disconnect']);

const idpOrigin = `https://${config.idpHost}`;
const bridgeRedirectUri = `${idpOrigin}/fedcm/callback`;

const endpoints = {
  accounts: `${idpOrigin}/fedcm/accounts`,
  clientMetadata: `${idpOrigin}/fedcm/client_metadata`,
  assertion: `${idpOrigin}/fedcm/assertion`,
  disconnect: `${idpOrigin}/fedcm/disconnect`,
  login: `${idpOrigin}/fedcm/login`,
};

// --- helpers ----------------------------------------------------------------

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function html(body, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function cors(origin) {
  return { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
}

// Browsers mark every FedCM fetch with Sec-Fetch-Dest: webidentity; it cannot be set by page script
function isWebIdentity(request) {
  return request.headers.get('sec-fetch-dest') === 'webidentity';
}

function rpForOrigin(clientId, origin) {
  const rp = config.rpClients[clientId];
  return rp && rp.origins.includes(origin) ? rp : null;
}

function randomString(bytes = 16) {
  const raw = String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)));
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwtPayload(jwt) {
  const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))));
}

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') ?? '').split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

// Applies Set-Cookie headers from an Auth0 hop to the Cookie header sent on the next hop
function mergeCookies(cookieHeader, setCookies) {
  const jar = new Map();
  for (const part of cookieHeader.split(/;\s*/).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq), part.slice(eq + 1));
  }
  for (const setCookie of setCookies) {
    const [pair] = setCookie.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const value = pair.slice(eq + 1);
    if (value) jar.set(pair.slice(0, eq), value);
    else jar.delete(pair.slice(0, eq));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

// --- Auth0 back-channel ------------------------------------------------------

// Runs /authorize server-side with the browser's Auth0 cookies, following Auth0's own
// same-host hops (e.g. /authorize/resume) until it redirects to the client's redirect_uri.
// Returns that final redirect URL (carrying code or error), or null.
async function runAuthorize(request, env, params) {
  let cookie = request.headers.get('cookie') ?? '';
  let path = `/authorize?${new URLSearchParams(params)}`;

  for (let hop = 0; hop < 5; hop++) {
    const res = await auth0Fetch(request, env, path, { cookie });
    const location = res.headers.get('location');
    if (!location) {
      console.log('authorize: no redirect', res.status, path);
      return null;
    }
    const next = new URL(location, idpOrigin);
    if (next.origin !== idpOrigin || next.pathname === '/fedcm/callback') return next;
    cookie = mergeCookies(cookie, res.headers.getSetCookie());
    path = next.pathname + next.search;
  }
  console.log('authorize: too many hops');
  return null;
}

async function exchangeBridgeCode(request, env, code) {
  const res = await auth0Fetch(request, env, '/oauth/token', {
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.bridgeClientId,
      client_secret: env.BRIDGE_CLIENT_SECRET,
      code,
      redirect_uri: bridgeRedirectUri,
    }),
  });
  if (!res.ok) {
    console.log('bridge code exchange failed', res.status, await res.text());
    return null;
  }
  const { id_token } = await res.json();
  // Received directly from Auth0's token endpoint over TLS, so the signature check can be
  // skipped (OIDC Core 3.1.3.7); these claims are only used to describe the account.
  return decodeJwtPayload(id_token);
}

// "Who is logged in to Auth0 in this browser?" — silent authorization under the bridge client
async function sessionUser(request, env) {
  if (readCookie(request, 'auth0') === null) return null;

  const result = await runAuthorize(request, env, {
    client_id: config.bridgeClientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: bridgeRedirectUri,
    scope: SCOPE,
    prompt: 'none',
    state: randomString(),
  });
  const code = result?.searchParams.get('code');
  if (!code) {
    console.log('no Auth0 session', result?.searchParams.get('error'));
    return null;
  }
  return exchangeBridgeCode(request, env, code);
}

// --- FedCM endpoints ---------------------------------------------------------

// accounts_endpoint and login_url must equal those in the well-known file served by
// workers/web-identity; `make check` verifies they match
function configFile() {
  return json({
    accounts_endpoint: endpoints.accounts,
    client_metadata_endpoint: endpoints.clientMetadata,
    id_assertion_endpoint: endpoints.assertion,
    disconnect_endpoint: endpoints.disconnect,
    login_url: endpoints.login,
    branding: { background_color: '#1f2a44', color: '#ffffff' },
  });
}

async function accounts(request, env) {
  if (!isWebIdentity(request)) return json({ error: 'invalid_request' }, { status: 400 });

  const user = await sessionUser(request, env);
  if (!user) return json({ error: 'login_required' }, { status: 401 });

  return json({
    accounts: [
      {
        id: user.sub,
        name: user.name ?? user.email,
        given_name: user.given_name ?? user.nickname,
        email: user.email,
        picture: user.picture,
        // All demo RPs are first-party clients of this tenant
        approved_clients: Object.keys(config.rpClients),
      },
    ],
  });
}

function clientMetadata(request, env, url) {
  const rp = config.rpClients[url.searchParams.get('client_id')];
  if (!rp) return json({ error: 'unknown client_id' }, { status: 404 });
  return json({ privacy_policy_url: rp.privacy_policy_url, terms_of_service_url: rp.terms_of_service_url });
}

function preflight(request) {
  const origin = request.headers.get('origin');
  const allowed = Object.values(config.rpClients).some((rp) => rp.origins.includes(origin));
  if (!allowed) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { ...cors(origin), 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' },
  });
}

// Returns an Auth0 authorization code for the RP's own client_id, bound to the RP's PKCE
// challenge. The RP redeems it at /oauth/token like any other code; the Worker never sees RP tokens.
async function assertion(request, env) {
  const origin = request.headers.get('origin');
  const form = await request.formData();
  const clientId = form.get('client_id');

  // Unknown origin/client pairs get no CORS headers, so the RP learns nothing
  if (!rpForOrigin(clientId, origin)) return json({ error: { code: 'unauthorized_client' } }, { status: 403 });

  // FedCM reads error bodies only from 2xx responses
  const reply = (body) => json(body, { headers: cors(origin) });
  if (!isWebIdentity(request)) return reply({ error: { code: 'invalid_request' } });

  let params;
  try {
    params = JSON.parse(form.get('params') ?? '{}');
    if (new URL(params.redirect_uri).origin !== origin) throw new Error('redirect_uri not on RP origin');
  } catch (e) {
    console.log('assertion: bad params', e.message);
    return reply({ error: { code: 'invalid_request' } });
  }

  const user = await sessionUser(request, env);
  if (!user) return reply({ error: { code: 'login_required', url: endpoints.login } });
  if (user.sub !== form.get('account_id')) return reply({ error: { code: 'access_denied' } });

  const authorize = { client_id: clientId, response_type: 'code', response_mode: 'query', prompt: 'none', scope: SCOPE };
  for (const name of RP_AUTHORIZE_PARAMS) if (params[name]) authorize[name] = params[name];

  const result = await runAuthorize(request, env, authorize);
  if (!result || result.origin !== origin) return reply({ error: { code: 'server_error' } });

  const error = result.searchParams.get('error');
  if (error) return reply({ error: { code: error } });
  if (result.searchParams.get('state') !== (params.state ?? null)) return reply({ error: { code: 'server_error' } });

  console.log('assertion issued', {
    client_id: clientId,
    sub: user.sub,
    is_auto_selected: form.get('is_auto_selected'),
    disclosure_text_shown: form.get('disclosure_text_shown'),
  });
  return reply({ token: result.searchParams.get('code') });
}

async function disconnect(request) {
  const origin = request.headers.get('origin');
  const form = await request.formData();
  if (!rpForOrigin(form.get('client_id'), origin) || !isWebIdentity(request)) {
    return json({ error: 'invalid_request' }, { status: 400 });
  }
  // Nothing to revoke: approvals are derived from tenant config, not stored per user
  console.log('disconnect', form.get('client_id'), form.get('account_hint'));
  return json({ account_id: form.get('account_hint') }, { headers: cors(origin) });
}

// FedCM login_url: interactive Universal Login under the bridge client, in the FedCM pop-up
function login(request, env, url) {
  const state = randomString();
  const authorize = new URLSearchParams({
    client_id: config.bridgeClientId,
    response_type: 'code',
    redirect_uri: bridgeRedirectUri,
    scope: SCOPE,
    state,
  });
  const loginHint = url.searchParams.get('login_hint');
  if (loginHint) authorize.set('login_hint', loginHint);

  return new Response(null, {
    status: 302,
    headers: {
      location: `/authorize?${authorize}`,
      'set-cookie': `${STATE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}

function statusPage({ user, message }) {
  const body = user
    ? `<p>Signed in to <b>${escapeHtml(config.idpHost)}</b> as <b>${escapeHtml(user.name)}</b> (${escapeHtml(user.email)})</p>`
    : `<p>Not signed in${message ? `: ${escapeHtml(message)}` : ''}. <a href="/fedcm/login">Sign in</a></p>`;
  const apps = Object.values(config.rpClients)
    .map((rp) => `<li><a href="${escapeHtml(rp.origins[0])}/">${escapeHtml(rp.name)}</a></li>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>FedCM IdP</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}</style></head>
<body>
<h1>FedCM IdP &mdash; ${escapeHtml(config.idpHost)}</h1>
${body}
<h2>Apps</h2><ul>${apps}</ul>
<script>
  (async () => {
    try { if (navigator.login) await navigator.login.setStatus(${user ? "'logged-in'" : "'logged-out'"}); } catch (e) { console.warn(e); }
    // Inside the FedCM login pop-up this hands control back to the browser; elsewhere it is a no-op
    try { if (window.IdentityProvider) IdentityProvider.close(); } catch (e) { console.warn(e); }
  })();
</script>
</body></html>`;
}

async function callback(request, env, url) {
  const expected = readCookie(request, STATE_COOKIE);
  const error = url.searchParams.get('error');
  let user = null;
  let message = null;

  if (error) message = `${error} ${url.searchParams.get('error_description') ?? ''}`;
  else if (!expected || url.searchParams.get('state') !== expected) message = 'state mismatch';
  else if (!(user = await exchangeBridgeCode(request, env, url.searchParams.get('code')))) message = 'code exchange failed';

  return html(statusPage({ user, message }), {
    headers: {
      'set-cookie': `${STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      'set-login': user ? 'logged-in' : 'logged-out',
    },
  });
}

async function home(request, env) {
  const user = await sessionUser(request, env);
  return html(statusPage({ user }), { headers: { 'set-login': user ? 'logged-in' : 'logged-out' } });
}

const routes = {
  'GET /': home,
  'GET /fedcm/config.json': configFile,
  'GET /fedcm/accounts': accounts,
  'GET /fedcm/client_metadata': clientMetadata,
  'POST /fedcm/assertion': assertion,
  'POST /fedcm/disconnect': disconnect,
  'GET /fedcm/login': login,
  'GET /fedcm/callback': callback,
};

// Returns a Response for FedCM/IdP routes, or null to fall through to the Auth0 proxy
export async function handleFedcm(request, env, url) {
  if (request.method === 'OPTIONS' && CORS_PATHS.has(url.pathname)) return preflight(request);
  const handler = routes[`${request.method} ${url.pathname}`];
  if (!handler) return null;
  console.log('fedcm', request.method, url.pathname, request.headers.get('sec-fetch-dest'));
  return handler(request, env, url);
}
