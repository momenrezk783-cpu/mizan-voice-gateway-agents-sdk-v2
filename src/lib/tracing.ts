import { LangfuseSpanProcessor } from "@langfuse/otel";
import { ROOT_CONTEXT, trace, SpanStatusCode, type Span, type Attributes } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

export interface TracingEnv {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  ENVIRONMENT?: string;
}

// Deliberately omit all free text, audio, tool arguments and provider errors:
// callers can disclose medical information and names that regexes cannot redact.
export class VoiceTrace {
  private constructor(
    private provider: BasicTracerProvider | undefined,
    private root: Span | undefined,
    private attributes: Attributes
  ) {}

  static start(env: TracingEnv, sessionId: string, tenantId: string, name = "process-voice-turn"): VoiceTrace {
    const attributes: Attributes = {
      "langfuse.session.id": sessionId,
      "langfuse.trace.name": name,
      "langfuse.trace.tags": ["voice"],
      "langfuse.environment": env.ENVIRONMENT || "development",
      "langfuse.trace.metadata.tenant_id": tenantId
    };
    if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY || !env.LANGFUSE_BASE_URL) {
      return new VoiceTrace(undefined, undefined, attributes);
    }
    try {
      const url = new URL(env.LANGFUSE_BASE_URL);
      if (url.protocol !== "https:") throw new Error("HTTPS required");
      const provider = new BasicTracerProvider({
        spanProcessors: [new LangfuseSpanProcessor({
          publicKey: env.LANGFUSE_PUBLIC_KEY,
          secretKey: env.LANGFUSE_SECRET_KEY,
          baseUrl: url.origin,
          environment: env.ENVIRONMENT || "development",
          // Only this turn's explicitly selected observations are exported.
          shouldExportSpan: () => true,
          timeout: 3,
          compression: "none",
          mediaUploadEnabled: false
        })]
      });
      const root = provider.getTracer("mizan-voice").startSpan(name, {
        attributes: { ...attributes, "langfuse.observation.type": "agent" }
      }, ROOT_CONTEXT);
      return new VoiceTrace(provider, root, attributes);
    } catch {
      console.warn("Langfuse tracing initialization failed");
      return new VoiceTrace(undefined, undefined, attributes);
    }
  }

  metadata(values: Attributes): void {
    this.root?.setAttributes(values);
  }

  async step<T>(name: string, type: "generation" | "tool" | "span" | "retriever" | "guardrail", fn: () => Promise<T>, attributes: Attributes = {}, usage?: (result: T) => Attributes): Promise<T> {
    const span = this.provider?.getTracer("mizan-voice").startSpan(name, {
      attributes: { ...this.attributes, ...attributes, "langfuse.observation.type": type }
    }, this.root ? trace.setSpan(ROOT_CONTEXT, this.root) : ROOT_CONTEXT);
    try {
      const result = await fn();
      if (span && usage) {
        try { span.setAttributes(usage(result)); }
        catch { console.warn("Langfuse usage recording failed"); }
      }
      return result;
    } catch (error) {
      span?.setStatus({ code: SpanStatusCode.ERROR, message: "Operation failed" });
      span?.setAttribute("langfuse.observation.level", "ERROR");
      throw error;
    } finally {
      span?.end();
    }
  }

  fail(): void {
    this.root?.setStatus({ code: SpanStatusCode.ERROR, message: "Voice pipeline failed" });
  }

  async finish(): Promise<void> {
    this.root?.end();
    // Await from the DO event handler: no process-global timers or exporters,
    // no cross-request I/O, and no dependency on a later WebSocket event.
    try { await this.provider?.shutdown(); }
    catch { console.warn("Langfuse trace export failed"); }
  }
}

export function generationUsage(result: { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }): Attributes {
  const usage: Record<string, number> = {};
  if (result.usage?.inputTokens != null) usage.input = result.usage.inputTokens;
  if (result.usage?.outputTokens != null) usage.output = result.usage.outputTokens;
  if (result.usage?.totalTokens != null) usage.total = result.usage.totalTokens;
  return { "langfuse.observation.usage_details": JSON.stringify(usage) };
}
