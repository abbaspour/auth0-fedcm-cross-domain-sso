// Offline tests for workers/idp and workers/web-identity against a mocked Auth0.
// Run: node tests/workers.test.mjs   (or `make test`)
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The IdP origin comes from the web-identity Worker's config so the tests follow a fork's domains
const webIdentityEnv = {
  IDP_ORIGIN: /IDP_ORIGIN\s*=\s*"([^"]+)"/.exec(readFileSync(join(ROOT, 'workers/web-identity/wrangler.toml'), 'utf8'))[1],
};
const IDP = webIdentityEnv.IDP_ORIGIN;
const RP = 'https://rp-app.example';
const AUTH0_ORIGIN = 'fedcm-demo-cd-test.edge.tenants.au.auth0.com';

// IdP sources import ./config.generated.js; run them next to a fixture instead of the real one
const work = mkdtempSync(join(tmpdir(), 'fedcm-idp-'));
cpSync(join(ROOT, 'workers/idp/src'), work, { recursive: true });
writeFileSync(join(work, 'config.generated.js'), `export default ${JSON.stringify({
  idpHost: new URL(IDP).host,
  auth0Origin: AUTH0_ORIGIN,
  bridgeClientId: 'BRIDGE',
  rpClients: {
    LOGIN: { name: 'Login app', origins: ['https://login-app.example'], privacy_policy_url: 'https://login-app.example/#privacy', terms_of_service_url: 'https://login-app.example/#terms' },
    RP: { name: 'FedCM app', origins: [RP], privacy_policy_url: `${RP}/#privacy`, terms_of_service_url: `${RP}/#terms` },
  },
})};`);

const { default: idp } = await import(pathToFileURL(join(work, 'index.js')).href);
const { default: webIdentity } = await import(pathToFileURL(join(ROOT, 'workers/web-identity/src/index.js')).href);
const env = { CNAME_API_KEY: 'CNAME-KEY', BRIDGE_CLIENT_SECRET: 'BRIDGE-SECRET' };

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const seen = [];
const quiet = console.log;
console.log = () => {};

// Mock of the Auth0 custom-domain origin
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const h = new Headers(init.headers);
  seen.push({ url: url.href, cname: h.get('cname-api-key'), ip: h.get('true-client-ip'), redirect: init.redirect });
  assert.equal(url.host, AUTH0_ORIGIN);
  assert.equal(h.get('cname-api-key'), 'CNAME-KEY');

  if (url.pathname === '/authorize' && url.searchParams.get('prompt') === 'none') {
    const ru = url.searchParams.get('redirect_uri');
    const st = url.searchParams.get('state');
    if (!/auth0=valid/.test(h.get('cookie') ?? '')) {
      return new Response(null, { status: 302, headers: { location: `${ru}?error=login_required&state=${st}` } });
    }
    // Auth0-internal hop whose cookie must be carried to the next hop
    return new Response(null, {
      status: 302,
      headers: {
        location: `/authorize/resume?ru=${encodeURIComponent(ru)}&st=${st}&cid=${url.searchParams.get('client_id')}`,
        'set-cookie': 'auth0_tx=abc; Path=/',
      },
    });
  }
  if (url.pathname === '/authorize/resume') {
    assert.match(h.get('cookie'), /auth0_tx=abc/);
    const q = url.searchParams;
    return new Response(null, { status: 302, headers: { location: `${q.get('ru')}?code=CODE_${q.get('cid')}&state=${q.get('st')}` } });
  }
  if (url.pathname === '/oauth/token') {
    const body = new URLSearchParams(init.body.toString());
    assert.equal(body.get('client_secret'), 'BRIDGE-SECRET');
    assert.equal(body.get('code'), 'CODE_BRIDGE');
    return Response.json({ id_token: `x.${b64u({ sub: 'auth0|123', name: 'Amin', email: 'a@b.c', picture: 'https://p/x.png' })}.y` });
  }
  if (url.pathname === '/u/login') {
    return new Response('ok', { status: 302, headers: { location: `${RP}/?code=XYZ&state=s`, 'set-cookie': 'auth0=valid; Path=/; Secure; SameSite=None' } });
  }
  if (url.pathname === '/v2/logout') {
    return new Response(null, { status: 302, headers: { location: RP, 'set-cookie': 'auth0=; Max-Age=0' } });
  }
  return new Response('upstream', { status: 200 });
};

const call = (worker, workerEnv, url, { method = 'GET', headers = {}, body } = {}) =>
  worker.fetch(new Request(url, { method, headers: { 'cf-connecting-ip': '1.2.3.4', ...headers }, body, redirect: 'manual' }), workerEnv);
const idpCall = (path, opts) => call(idp, env, IDP + path, opts);
const wid = { 'sec-fetch-dest': 'webidentity' };
const ct = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('web-identity serves the well-known file only', async () => {
  const r = await call(webIdentity, webIdentityEnv, 'https://idp-site.example/.well-known/web-identity');
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.deepEqual((await r.json()).provider_urls, [`${IDP}/fedcm/config.json`]);
  assert.equal((await call(webIdentity, webIdentityEnv, 'https://idp-site.example/x')).status, 404);
});

test('well-known and config.json agree (duplicated config drift guard)', async () => {
  const wk = await (await call(webIdentity, webIdentityEnv, 'https://idp-site.example/.well-known/web-identity')).json();
  const cfg = await (await idpCall('/fedcm/config.json')).json();
  assert.equal(wk.accounts_endpoint, cfg.accounts_endpoint);
  assert.equal(wk.login_url, cfg.login_url);
});

test('accounts endpoint', async () => {
  assert.equal((await idpCall('/fedcm/accounts')).status, 400);
  assert.equal((await idpCall('/fedcm/accounts', { headers: wid })).status, 401);
  const j = await (await idpCall('/fedcm/accounts', { headers: { ...wid, cookie: 'auth0=valid; did=1' } })).json();
  assert.equal(j.accounts[0].id, 'auth0|123');
  assert.deepEqual(j.accounts[0].approved_clients.sort(), ['LOGIN', 'RP']);
  assert.equal(seen.find((s) => s.url.includes('/authorize')).ip, '1.2.3.4');
});

test('client metadata', async () => {
  const j = await (await idpCall('/fedcm/client_metadata?client_id=RP')).json();
  assert.equal(j.privacy_policy_url, `${RP}/#privacy`);
});

test('id assertion', async () => {
  const params = { redirect_uri: `${RP}/`, scope: 'openid profile email', state: 'S1', nonce: 'N1', code_challenge: 'CC', code_challenge_method: 'S256', evil: 'x' };
  const body = form({ client_id: 'RP', account_id: 'auth0|123', is_auto_selected: 'false', params: JSON.stringify(params) });
  const post = (headers, b = body) => idpCall('/fedcm/assertion', { method: 'POST', headers: { ...wid, ...ct, ...headers }, body: b });

  let r = await post({ origin: 'https://evil.example', cookie: 'auth0=valid' });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('access-control-allow-origin'), null);

  seen.length = 0;
  r = await post({ origin: RP, cookie: 'auth0=valid' });
  assert.equal(r.headers.get('access-control-allow-origin'), RP);
  assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
  assert.deepEqual(await r.json(), { token: 'CODE_RP' });
  const authorize = new URL(seen.filter((s) => s.url.includes('/authorize?')).at(-1).url).searchParams;
  assert.equal(authorize.get('client_id'), 'RP');
  assert.equal(authorize.get('code_challenge'), 'CC');
  assert.equal(authorize.get('prompt'), 'none');
  assert.equal(authorize.get('evil'), null);

  assert.equal((await (await post({ origin: RP })).json()).error.code, 'login_required');
  r = await post({ origin: RP, cookie: 'auth0=valid' }, form({ client_id: 'RP', account_id: 'auth0|other', params: JSON.stringify(params) }));
  assert.equal((await r.json()).error.code, 'access_denied');
  r = await post({ origin: RP, cookie: 'auth0=valid' }, form({ client_id: 'RP', account_id: 'auth0|123', params: JSON.stringify({ ...params, redirect_uri: 'https://evil.example/' }) }));
  assert.equal((await r.json()).error.code, 'invalid_request');
});

test('preflight and disconnect', async () => {
  assert.equal((await idpCall('/fedcm/assertion', { method: 'OPTIONS', headers: { origin: RP } })).status, 204);
  const r = await idpCall('/fedcm/disconnect', { method: 'POST', headers: { ...wid, ...ct, origin: RP }, body: form({ client_id: 'RP', account_hint: 'auth0|123' }) });
  assert.deepEqual(await r.json(), { account_id: 'auth0|123' });
});

test('login_url and callback', async () => {
  let r = await idpCall('/fedcm/login?login_hint=a@b.c');
  assert.equal(r.status, 302);
  const location = new URL(r.headers.get('location'), IDP);
  assert.equal(location.searchParams.get('client_id'), 'BRIDGE');
  const state = /__Host-fedcm_state=([^;]+)/.exec(r.headers.get('set-cookie'))[1];
  assert.equal(location.searchParams.get('state'), state);

  r = await idpCall(`/fedcm/callback?code=CODE_BRIDGE&state=${state}`, { headers: { cookie: `__Host-fedcm_state=${state}` } });
  assert.equal(r.headers.get('set-login'), 'logged-in');
  assert.match(await r.text(), /Signed in to .* as <b>Amin<\/b>/);
  r = await idpCall('/fedcm/callback?code=CODE_BRIDGE&state=wrong', { headers: { cookie: `__Host-fedcm_state=${state}` } });
  assert.equal(r.headers.get('set-login'), 'logged-out');
});

test('reverse proxy and Set-Login injection', async () => {
  let r = await idpCall('/u/login?state=s', { method: 'POST', headers: ct, body: 'username=a' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('set-login'), 'logged-in');
  assert.match(r.headers.get('set-cookie'), /auth0=valid/);
  assert.deepEqual(seen.at(-1), { ...seen.at(-1), cname: 'CNAME-KEY', ip: '1.2.3.4', redirect: 'manual' });
  assert.equal((await idpCall('/v2/logout?returnTo=x')).headers.get('set-login'), 'logged-out');
  r = await idpCall('/.well-known/openid-configuration');
  assert.equal(r.headers.get('set-login'), null);
  assert.equal(await r.text(), 'upstream');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    quiet(`ok    ${name}`);
  } catch (e) {
    failed++;
    quiet(`FAIL  ${name}\n${e.stack}`);
  }
}
rmSync(work, { recursive: true, force: true });
quiet(failed ? `${failed} test(s) failed` : 'all tests passed');
process.exit(failed ? 1 : 0);
