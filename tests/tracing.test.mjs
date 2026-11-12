import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// Exercise the real Langfuse processor with an in-memory transport so tests
// need neither credentials nor network and can audit exactly what is exported.
const batches = [];
globalThis.__tracingTestExporter = {
  export(spans, callback) { batches.push(...spans); callback(globalThis.__tracingTestFail ? { code: 1, error: new Error("test transport failure") } : { code: 0 }); },
  async shutdown() {},
  async forceFlush() {}
};
const source = fs.readFileSync(new URL("../src/lib/tracing.ts", import.meta.url), "utf8")
  .replace('compression: "none",', '')
  .replace('new LangfuseSpanProcessor({', 'new LangfuseSpanProcessor({ exporter: globalThis.__tracingTestExporter,')
  .replace(/from "([^".][^"]*)"/g, (_, spec) => `from ${JSON.stringify(import.meta.resolve(spec))}`);
const code = ts.transpile(source,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext});
const { VoiceTrace, generationUsage } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const disabled = VoiceTrace.start({}, "session-disabled", "tenant");
assert.equal(await disabled.step("test", "tool", async () => 42), 42);
await disabled.finish();
assert.equal(batches.length, 0);

const env = { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test", LANGFUSE_BASE_URL: "https://example.invalid", ENVIRONMENT: "test" };
const a = VoiceTrace.start(env, "session-a", "tenant-a");
const b = VoiceTrace.start(env, "session-b", "tenant-b");
await Promise.all([
  a.step("generate-response", "generation", async () => ({ text: "PATIENT SECRET", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }), { "langfuse.observation.model.name": "test-model" }, generationUsage),
  b.step("execute-conversation-tool", "tool", async () => ({ phone: "01012345678" }))
]);
const failure = new Error("provider secret and patient details");
await assert.rejects(a.step("generate-fallback-response", "generation", async () => { throw failure; }), (error) => error === failure);
a.metadata({ "langfuse.observation.output": JSON.stringify({ state: "CLOSING" }) });
await Promise.all([a.finish(), b.finish()]);
const rootA = batches.find(s => s.name === "process-voice-turn" && s.attributes["langfuse.session.id"] === "session-a");
const rootB = batches.find(s => s.name === "process-voice-turn" && s.attributes["langfuse.session.id"] === "session-b");
assert.ok(rootA && rootB);
assert.notEqual(rootA.spanContext().traceId, rootB.spanContext().traceId);
const generation = batches.find(s => s.name === "generate-response");
assert.equal(generation.parentSpanContext.spanId, rootA.spanContext().spanId);
assert.equal(generation.attributes["langfuse.observation.type"], "generation");
assert.deepEqual(JSON.parse(generation.attributes["langfuse.observation.usage_details"]), { input: 12, output: 3, total: 15 });
assert.equal(generation.attributes["langfuse.observation.model.name"], "test-model");
const tool = batches.find(s => s.name === "execute-conversation-tool");
assert.equal(tool.parentSpanContext.spanId, rootB.spanContext().spanId);
assert.equal(tool.attributes["langfuse.trace.metadata.tenant_id"], "tenant-b");
assert.equal(batches.find(s => s.name === "generate-fallback-response").status.code, 2);
for (const span of batches) {
  assert.equal(span.attributes["langfuse.environment"], "test");
  const serialized = JSON.stringify({ attributes: span.attributes, status: span.status, events: span.events });
  assert.doesNotMatch(serialized, /PATIENT SECRET|01012345678|provider secret|sk-test/);
  assert.ok(span.endTime);
}
assert.deepEqual(generationUsage({}), { "langfuse.observation.usage_details": "{}" });
const usageFailure = VoiceTrace.start(env, "usage-failure", "tenant-a");
assert.equal(await usageFailure.step("record-usage", "generation", async () => "unchanged", {}, () => { throw new Error("broken measurement"); }), "unchanged");
globalThis.__tracingTestFail = true;
await usageFailure.finish(); // Transport failure must never fail a call.
delete globalThis.__tracingTestFail;
delete globalThis.__tracingTestExporter;
console.log("[PASS] Tracing: disablement, concurrent isolation, hierarchy, usage, privacy, failures, shutdown/export");
