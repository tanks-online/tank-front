// Cloudflare Workers Free: HTTPS/WSS entry point only.
// Static files and all authoritative gameplay run on the Enzonic Node server.
const UPSTREAM = 'http://sgp-two.enzonic.com:25610';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
    }
    const upgrade = request.headers.get('Upgrade');
    if (upgrade && (upgrade.toLowerCase() !== 'websocket' || url.pathname !== '/ws')) {
      return new Response('Invalid WebSocket path', { status: 400 });
    }
    const target = new URL(UPSTREAM);
    target.pathname = url.pathname;
    target.search = url.search;
    const headers = new Headers(request.headers);
    for (const name of ['host', 'cookie', 'authorization', 'proxy-authorization', 'forwarded', 'x-forwarded-host']) {
      headers.delete(name);
    }
    // Preserve Origin so the Node server can enforce its exact allowed website.
    try {
      return await fetch(new Request(target, {
        method: request.method,
        headers,
        redirect: 'manual',
      }));
    } catch {
      return new Response('Сервер Enzonic пока недоступен. Подождите и попробуйте снова.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  },
};
