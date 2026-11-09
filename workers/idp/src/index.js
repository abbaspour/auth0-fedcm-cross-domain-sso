import { handleFedcm } from './fedcm.js';
import { proxyToAuth0 } from './proxy.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    return (await handleFedcm(request, env, url)) ?? proxyToAuth0(request, env);
  },
};
