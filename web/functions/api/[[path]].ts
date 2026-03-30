// Cloudflare Pages Function — proxies /api/* requests to the Worker.
// Set the WORKER_URL environment variable in Cloudflare Pages settings
// e.g. https://worker.<your-subdomain>.workers.dev

interface Env {
  WORKER_URL: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const workerBase = context.env.WORKER_URL;
  if (!workerBase) {
    return new Response(JSON.stringify({ error: 'WORKER_URL not configured' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(context.request.url);
  const target = new URL(url.pathname + url.search, workerBase);

  const headers = new Headers(context.request.headers);
  headers.set('X-Forwarded-Host', url.hostname);

  const init: RequestInit = {
    method: context.request.method,
    headers,
  };

  if (!['GET', 'HEAD'].includes(context.request.method)) {
    init.body = context.request.body;
  }

  const response = await fetch(target.toString(), init);

  // Forward the response, preserving headers (especially Set-Cookie)
  const proxyHeaders = new Headers(response.headers);
  // Remove hop-by-hop headers
  proxyHeaders.delete('connection');
  proxyHeaders.delete('keep-alive');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: proxyHeaders,
  });
};
