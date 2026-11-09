// FedCM well-known file. accounts_endpoint and login_url must equal those in the IdP's
// config.json (workers/idp/src/fedcm.js) or the browser rejects the sign-in.
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname !== '/.well-known/web-identity') {
      return new Response('Not found', { status: 404 });
    }
    const body = {
      provider_urls: [`${env.IDP_ORIGIN}/fedcm/config.json`],
      accounts_endpoint: `${env.IDP_ORIGIN}/fedcm/accounts`,
      login_url: `${env.IDP_ORIGIN}/fedcm/login`,
    };
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    });
  },
};
