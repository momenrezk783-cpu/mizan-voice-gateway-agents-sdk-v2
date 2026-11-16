// ============================================================================
// Mizan Voice Studio Worker Entry Point (`src/studio-entry.ts`)
// ============================================================================
// Configured as `main = "src/studio-entry.ts"` in `wrangler.studio-dev.toml`.
// Keeps `/studio` and `/api/ops/*` out of the production `src/index.ts` bundle
// while delegating `/api/voice/token`, `/agents/mizan-voice-agent/*`,
// `/pcm-processor.js`, and `/c/:slug` to the real gateway handler so Dev tests
// the exact production voice pipeline.
// ============================================================================

import gatewayWorker, { MizanVoiceAgent } from "./index";
import {
  authenticateStudioRequest,
  handleStudioOpsApi,
  type StudioEnv
} from "./lib/studio-ops";

export { MizanVoiceAgent };

const STUDIO_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "microphone=(self), camera=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: https:; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
};

export default {
  async fetch(request: Request, env: StudioEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Fail-closed: never serve Studio routes if ENVIRONMENT is production
    if (env.ENVIRONMENT === "production") {
      return gatewayWorker.fetch(request, env, ctx);
    }

    if (url.pathname.startsWith("/api/ops/")) {
      return handleStudioOpsApi(request, env, url);
    }

    if (
      (url.pathname === "/studio" || url.pathname === "/studio.html") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      const auth = await authenticateStudioRequest(request, env, url);
      if (!auth.ok) {
        if (auth.status === 401 && (request.headers.get("Accept") || "").includes("text/html")) {
          return Response.redirect(new URL("/login", url.origin).toString(), 302);
        }
        return new Response(auth.error, {
          status: auth.status,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...STUDIO_SECURITY_HEADERS }
        });
      }

      const assetReq = new Request(new URL("/studio.html", url.origin).toString(), request);
      const assetRes = await env.ASSETS.fetch(assetReq);
      return new Response(request.method === "HEAD" ? null : assetRes.body, {
        status: assetRes.status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          ...STUDIO_SECURITY_HEADERS
        }
      });
    }

    if (url.pathname === "/js/studio.js" && (request.method === "GET" || request.method === "HEAD")) {
      const assetReq = new Request(new URL("/js/studio.js", url.origin).toString(), request);
      const assetRes = await env.ASSETS.fetch(assetReq);
      return new Response(request.method === "HEAD" ? null : assetRes.body, {
        status: assetRes.status,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          ...STUDIO_SECURITY_HEADERS
        }
      });
    }

    return gatewayWorker.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<any>, env: StudioEnv): Promise<void> {
    return gatewayWorker.queue(batch, env);
  },

  async scheduled(event: ScheduledEvent, env: StudioEnv, ctx: ExecutionContext): Promise<void> {
    return gatewayWorker.scheduled(event, env, ctx);
  }
};
