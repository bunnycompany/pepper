// pepper.software edge worker: `curl -fsSL pepper.software | sh` gets the
// install script; browsers get the landing page. Everything else is static.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ua = request.headers.get('user-agent') || '';
    const wantsScript = url.pathname === '/install'
      || (url.pathname === '/' && /\b(curl|wget|fetch)\b/i.test(ua));
    if (wantsScript) {
      const asset = await env.ASSETS.fetch(new Request(new URL('/install', url.origin), request));
      return new Response(asset.body, {
        status: asset.status,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
