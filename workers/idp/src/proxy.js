import config from './config.generated.js';

// Cloudflare-managed request headers that must not be replayed to the Auth0 origin
const STRIPPED_HEADERS = ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-real-ip'];

function auth0Url(pathAndQuery) {
  return new URL(pathAndQuery, `https://${config.auth0Origin}`);
}

// Headers every request to the self-managed custom domain origin needs: the cname-api-key
// authenticates the proxy, true-client-ip carries the end user's IP (custom_client_ip_header).
function setOriginHeaders(headers, request, env) {
  headers.set('cname-api-key', env.CNAME_API_KEY);
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('true-client-ip', clientIp);
  return headers;
}

// Derives the FedCM IdP login status from an Auth0 response, so the browser learns about
// logins/logouts that happen anywhere on the custom domain.
function loginStatus(pathname, upstream) {
  if (pathname === '/v2/logout' || pathname === '/oidc/logout') return 'logged-out';

  for (const cookie of upstream.headers.getSetCookie()) {
    const session = /^auth0=([^;]*)/i.exec(cookie);
    if (session && (!session[1] || /max-age=0|expires=thu, 01 jan 1970/i.test(cookie))) return 'logged-out';
  }

  const location = upstream.headers.get('location');
  if (location) {
    const params = new URL(location, 'https://invalid').searchParams;
    if (params.has('code')) return 'logged-in';
    if (params.get('error') === 'login_required') return 'logged-out';
  }
  return null;
}

// Transparent reverse proxy for all non-FedCM traffic on the custom domain
export async function proxyToAuth0(request, env) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of STRIPPED_HEADERS) headers.delete(name);

  const upstream = await fetch(auth0Url(url.pathname + url.search), {
    method: request.method,
    headers: setOriginHeaders(headers, request, env),
    body: request.body,
    redirect: 'manual',
  });

  const response = new Response(upstream.body, upstream);
  const status = loginStatus(url.pathname, upstream);
  if (status) response.headers.set('Set-Login', status);
  return response;
}

// Server-side call from the Worker to Auth0 on behalf of the browser (FedCM endpoints)
export function auth0Fetch(request, env, pathAndQuery, { method = 'GET', cookie, body, contentType } = {}) {
  const headers = new Headers();
  for (const name of ['user-agent', 'accept-language']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (cookie) headers.set('cookie', cookie);
  if (contentType) headers.set('content-type', contentType);

  return fetch(auth0Url(pathAndQuery), {
    method,
    headers: setOriginHeaders(headers, request, env),
    body,
    redirect: 'manual',
  });
}
