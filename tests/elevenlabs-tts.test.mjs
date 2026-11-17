import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const code = ts.transpile(fs.readFileSync(new URL("../src/lib/elevenlabs-tts.ts", import.meta.url), "utf8"),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext});
const { synthesizeDialogueAudio } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const config = { voice_id: "2DkHmQavK9V2UzTYrMYT", model_id: "eleven_v4_turbo", stability: 0.5, speed: 1.0, similarity_boost: 0.75 };
class Socket {
  listeners = new Map();
  sent = [];
  closed = false;
  constructor(events = []) { this.events = events; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  accept() { this.accepted = true; }
  send(data) {
    this.sent.push(JSON.parse(data));
    if (this.sent.length === 2) queueMicrotask(() => {
      for (const event of this.events) {
        if (event === "close") this.listeners.get("close")?.({});
        else this.listeners.get("message")?.({ data: typeof event === "string" ? event : JSON.stringify(event) });
      }
    });
  }
  close() { this.closed = true; this.listeners.get("close")?.({}); }
}
const chunk1 = Buffer.alloc(80, 1);
const chunk2 = Buffer.alloc(90, 2);
const socket = new Socket([{ audio: chunk1.toString("base64") }, { is_final_audio_for_turn: true }, { audio: chunk2.toString("base64") }, { is_final: true }]);
const fetcher = async (url, options) => {
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/v1/text-to-dialogue/stream-input");
  assert.equal(parsed.searchParams.get("model_id"), "eleven_v4_turbo");
  assert.equal(parsed.searchParams.get("language_code"), "ar");
  assert.equal(parsed.searchParams.get("output_format"), "mp3_44100_128");
  assert.equal(options.headers["xi-api-key"], "test-key");
  assert.ok(!url.includes("test-key"));
  return { status: 101, webSocket: socket };
};
const audio = await synthesizeDialogueAudio("أهلاً بيك", "test-key", config, "ar", fetcher);
assert.deepEqual(Buffer.from(audio), Buffer.concat([chunk1, chunk2]));
assert.deepEqual(socket.sent, [
  { voices: [config.voice_id], voice_settings: { stability: 0.5 } },
  { inputs: [{ text: "أهلاً بيك", voice_id: config.voice_id }], close_socket: true }
]);
assert.ok(socket.closed && socket.accepted);
for (const events of [ ["close"], [{ audio: "invalid@@" }], [{ is_final: true }], [{ error: "secret provider text" }] ]) {
  const ws = new Socket(events);
  await assert.rejects(synthesizeDialogueAudio("test", "test-key", config, "ar", async () => ({ status: 101, webSocket: ws })), error => !error.message.includes("secret"));
  assert.ok(ws.closed);
}
const timeoutSocket = new Socket();
await assert.rejects(synthesizeDialogueAudio("test", "test-key", config, "ar", async () => ({ status: 101, webSocket: timeoutSocket }), 10), /timed out/);
assert.ok(timeoutSocket.closed);
await assert.rejects(synthesizeDialogueAudio("test", "test-key", config, "ar", async () => ({ status: 401 })), /HTTP 401/);
await assert.rejects(synthesizeDialogueAudio("test", "", config, "ar", fetcher), /not configured/);
console.log("[PASS] ElevenLabs v4 Turbo: dialogue protocol, voice/language, audio assembly, timeout/error cleanup and secret handling");