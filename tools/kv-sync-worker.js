/**
 * Cloudflare Worker: ANSUD Voucher Sync Proxy
 *
 * This worker sits between the browser and Cloudflare KV. The browser calls
 * this worker; the worker uses its KV binding to read/write data.
 *
 * Why? Cloudflare's KV REST API does not allow browser CORS. A Worker fixes
 * that and also keeps your Cloudflare API token out of the browser.
 *
 * Deployment (wrangler):
 *   1. npm create cloudflare@latest ansud-voucher-sync  (choose "Worker")
 *   2. Replace the generated src/index.js with this file.
 *   3. wrangler kv:namespace create ANSUD_KV
 *   4. Add the binding to wrangler.toml under [[kv_namespaces]]:
 *        [[kv_namespaces]]
 *        binding = "ANSUD_KV"
 *        id = "<namespace_id_from_step_3>"
 *   5. (Optional) set a sync password:
 *        wrangler secret put ANSUD_SYNC_PASSWORD
 *   6. wrangler deploy
 *   7. Copy the deployed URL (e.g. https://ansud-voucher-sync.YOUR_SUBDOMAIN.workers.dev)
 *      into the Cloud Sync panel of transportation-voucher.html.
 *
 * Endpoints:
 *   GET  /ping  -> {ok:true} (connection test)
 *   GET  /pull  -> {found:true, data:{...}} or {found:false}
 *   POST /push  <- JSON body; returns {ok:true}
 */

const KV_KEY = 'ansud-vouchers';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Password',
  'Content-Type': 'application/json'
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, ...extra }
  });
}

export default {
  async fetch(request, env, ctx) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // Optional password gate. If ANSUD_SYNC_PASSWORD is set in secrets,
    // the browser must send it in the X-Sync-Password header.
    const provided = request.headers.get('X-Sync-Password') || url.searchParams.get('pass');
    if (env.ANSUD_SYNC_PASSWORD && provided !== env.ANSUD_SYNC_PASSWORD) {
      return json({ ok: false, error: 'Unauthorized — wrong or missing sync password.' }, 401);
    }

    try {
      if (path === '/ping') {
        return json({ ok: true });
      }

      if (path === '/pull') {
        const stored = await env.ANSUD_KV.get(KV_KEY);
        if (stored === null) {
          return json({ found: false });
        }
        // Validate JSON before returning
        const data = JSON.parse(stored);
        return json({ found: true, data });
      }

      if (path === '/push') {
        const body = await request.text();
        // Validate JSON shape before storing
        JSON.parse(body);
        await env.ANSUD_KV.put(KV_KEY, body);
        return json({ ok: true });
      }

      return json({ ok: false, error: 'Not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }
};
