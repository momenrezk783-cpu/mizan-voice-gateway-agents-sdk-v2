import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {importTs} from './helpers/runtime.mjs';

const require = createRequire(import.meta.url);
const ts = require("typescript");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function transpileTs(relPath) {
  const fullPath = path.join(rootDir, relPath);
  const tsCode = fs.readFileSync(fullPath, "utf8");
  const result = ts.transpileModule(tsCode, {fileName:fullPath, compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.ESNext}});
  return result.outputText;
}

async function loadTsModule(relPath) {
  return importTs(relPath);
}

console.log("=== Running Mizan Voice Gateway Deepgram STT Migration Test Suite ===");

// ---------------------------------------------------------------------------
// 0. Syntax & TypeScript Transpilation Check Across All Repository Source Files
// ---------------------------------------------------------------------------
{
  const sourceFiles = [
    "src/lib/deepgram-stt.ts",
    "src/lib/search.ts",
    "src/lib/tenant.ts",
    "src/lib/auth.ts",
    "src/lib/crypto.ts",
    "src/lib/conversation-manager/guard.ts",
    "src/lib/conversation-manager/manager.ts",
    "src/lib/conversation-manager/prompt.ts",
    "src/lib/conversation-manager/evaluator.ts",
    "src/lib/conversation-manager/db.ts",
    "src/agent.ts",
    "src/index.ts"
  ];
  for (const file of sourceFiles) {
    const compiled = transpileTs(file);
    assert.ok(compiled && compiled.length > 0, `Failed to compile ${file}`);
  }
  console.log(`[PASS] 0. All ${sourceFiles.length} TypeScript modules transpiled successfully (full type-check requires dependency installation)`);
}

const deepgramMod = await loadTsModule("src/lib/deepgram-stt.ts");
const guardMod = await loadTsModule("src/lib/conversation-manager/guard.ts");

const {
  DeepgramStreamingSession,
  buildDeepgramListenUrl,
  computePcm16Rms,
  float32ToLinear16Pcm,
  normalizeToLinear16Pcm,
  isMeaningfulTranscript,
  detectTranscriptLanguage
} = deepgramMod;

const { extractCallerTitleAndName, sanitizeForSpeech } = guardMod;

class MockDeepgramSocket {
  readyState = 1;
  sentBinaryFrames = [];
  sentControlMessages = [];
  listeners = new Map();
  closed = false;

  send(data) {
    if (typeof data === "string") {
      this.sentControlMessages.push(JSON.parse(data));
    } else {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.sentBinaryFrames.push(bytes);
    }
  }

  close(code = 1000, reason = "") {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  addEventListener(type, fn) {
    const arr = this.listeners.get(type) || [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  emit(type, event) {
    for (const fn of this.listeners.get(type) || []) {
      fn(event);
    }
  }

  emitDeepgramJson(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

// ---------------------------------------------------------------------------
// 1. Audio Encoding & URL Configuration Verification
// ---------------------------------------------------------------------------
{
  const urlStr = buildDeepgramListenUrl({
    model: "nova-3",
    language: "ar",
    encoding: "linear16",
    sampleRate: 16000,
    channels: 1,
    endpointingMs: 300,
    utteranceEndMs: 1000
  });
  const parsed = new URL(urlStr);
  assert.equal(parsed.origin + parsed.pathname, "https://api.deepgram.com/v1/listen");
  assert.equal(parsed.searchParams.get("model"), "nova-3");
  assert.equal(parsed.searchParams.get("language"), "ar");
  assert.deepEqual(parsed.searchParams.getAll("language_hint"), [], "Arabic-only mode must not send English language hints");
  assert.equal(parsed.searchParams.get("encoding"), "linear16");
  assert.equal(parsed.searchParams.get("sample_rate"), "16000");
  assert.equal(parsed.searchParams.get("channels"), "1");
  assert.equal(parsed.searchParams.get("interim_results"), "true");
  assert.equal(parsed.searchParams.get("smart_format"), "true");
  assert.equal(parsed.searchParams.get("punctuate"), "true");
  assert.equal(parsed.searchParams.get("endpointing"), "300");
  assert.equal(parsed.searchParams.get("utterance_end_ms"), "1000");
  assert.equal(parsed.searchParams.get("vad_events"), "true");
  assert.ok(parsed.searchParams.getAll("keyterm").includes("ميزان"));

  // Float32 to Int16 linear16 conversion accuracy check
  const floatSamples = new Float32Array([0, 0.5, -0.5, 1.0, -1.0]);
  const linear16Bytes = normalizeToLinear16Pcm(floatSamples.buffer, "float32");
  assert.equal(linear16Bytes.byteLength, 10);
  const view = new DataView(linear16Bytes.buffer, linear16Bytes.byteOffset, linear16Bytes.byteLength);
  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(2, true), 16384);
  assert.equal(view.getInt16(4, true), -16384);
  assert.equal(view.getInt16(6, true), 32767);
  assert.equal(view.getInt16(8, true), -32768);

  // Odd-length malformed frame trimming check
  const malformed = new Uint8Array([0x01, 0x02, 0x03]);
  const trimmed = normalizeToLinear16Pcm(malformed.buffer, "linear16");
  assert.equal(trimmed.byteLength, 2);

  // 1-byte frame rejection
  const singleByte = new Uint8Array([0x01]);
  assert.equal(normalizeToLinear16Pcm(singleByte.buffer, "linear16").byteLength, 0);
  console.log("[PASS] 1. Audio encoding (linear16 16kHz mono) & Deepgram URL parameters verified");
}

// ---------------------------------------------------------------------------
// 2. STT Language & Utterance Tests (Egyptian Arabic, English, Mixed, Short, Long, Consecutive)
// ---------------------------------------------------------------------------
{
  let mockSocket = null;
  const finalOutputs = [];
  const interimOutputs = [];

  const session = new DeepgramStreamingSession(
    "dg-test-key",
    {
      onInterimTranscript: (text) => interimOutputs.push(text),
      onFinalTranscript: (text, confidence, lang) => {
        finalOutputs.push({ text, confidence, lang });
      }
    },
    {
      webSocketFactory: async () => {
        mockSocket = new MockDeepgramSocket();
        return mockSocket;
      }
    }
  );

  await session.connect();
  assert.ok(mockSocket, "Deepgram WebSocket must be connected");

  // (a) Egyptian Arabic speech
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: false,
    speech_final: false,
    channel: { alternatives: [{ transcript: "مساء الخير", confidence: 0.92 }] }
  });
  assert.equal(finalOutputs.length, 0, "Interim result must not trigger final callback");
  assert.equal(interimOutputs.length, 1);

  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "مساء الخير، عايز أحجز ميعاد بكرة مع دكتور أحمد.", confidence: 0.97 }] }
  });
  assert.equal(finalOutputs.length, 1);
  assert.equal(finalOutputs[0].text, "مساء الخير، عايز أحجز ميعاد بكرة مع دكتور أحمد.");
  assert.equal(finalOutputs[0].lang, "ar");

  // (b) English speech
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "Hello, I would like to book an appointment tomorrow.", confidence: 0.98 }] }
  });
  assert.equal(finalOutputs.length, 2);
  assert.equal(finalOutputs[1].text, "Hello, I would like to book an appointment tomorrow.");
  assert.equal(finalOutputs[1].lang, "en");

  // (c) Mixed Egyptian Arabic-English speech (preserves English words/names without translating)
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "أنا معاك من شركة Mizan Consult وعندي مشكلة في الـ follow up مع Dr. Sarah.", confidence: 0.95 }] }
  });
  assert.equal(finalOutputs.length, 3);
  assert.equal(finalOutputs[2].text, "أنا معاك من شركة Mizan Consult وعندي مشكلة في الـ follow up مع Dr. Sarah.");
  assert.equal(finalOutputs[2].lang, "ar");

  // (d) Short utterance
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "أيوه تمام", confidence: 0.94 }] }
  });
  assert.equal(finalOutputs.length, 4);
  assert.equal(finalOutputs[3].text, "أيوه تمام");

  // (e) Long multi-segment utterance assembled across multiple `is_final: true` chunks before `speech_final: true`
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: false,
    channel: { alternatives: [{ transcript: "لو سمحت أنا كنت كشفت الأسبوع اللي فات عند دكتورة منى", confidence: 0.96 }] }
  });
  assert.equal(finalOutputs.length, 4, "Must wait for speech_final or UtteranceEnd before triggering LLM");

  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "ومحتاج أعرف مواعيد الاستشارة يوم التلات الجاي الساعة كام.", confidence: 0.95 }] }
  });
  assert.equal(finalOutputs.length, 5);
  assert.equal(
    finalOutputs[4].text,
    "لو سمحت أنا كنت كشفت الأسبوع اللي فات عند دكتورة منى ومحتاج أعرف مواعيد الاستشارة يوم التلات الجاي الساعة كام."
  );

  session.close();
  console.log("[PASS] 2. STT tests (Egyptian Arabic, English, Mixed Ar-En, Short, Long, Consecutive turns) verified");
}

// ---------------------------------------------------------------------------
// 3. Repetition, Silence, Noise & Lifecycle Guard Tests
// ---------------------------------------------------------------------------
{
  let mockSocket = null;
  const finalOutputs = [];

  const session = new DeepgramStreamingSession(
    "dg-test-key",
    {
      onFinalTranscript: (text) => finalOutputs.push(text)
    },
    {
      webSocketFactory: async () => {
        mockSocket = new MockDeepgramSocket();
        return mockSocket;
      }
    }
  );

  await session.connect();

  // (a) Same non-silent audio frame sent twice in a row must not be forwarded twice
  const speechFrame = new Int16Array(2048);
  for (let i = 0; i < speechFrame.length; i++) {
    speechFrame[i] = Math.round(Math.sin(i * 0.2) * 12000);
  }
  const sent1 = session.sendAudio(speechFrame.buffer, "linear16");
  const sent2 = session.sendAudio(speechFrame.buffer, "linear16");
  assert.equal(sent1, true, "First non-silent frame must be sent");
  assert.equal(sent2, false, "Immediate duplicate audio frame must be suppressed");
  assert.equal(mockSocket.sentBinaryFrames.length, 1);

  // (b) `UtteranceEnd` arriving immediately after `speech_final: true` must NOT double-trigger the LLM
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "مساء الخير، إزيك؟", confidence: 0.98 }] }
  });
  mockSocket.emitDeepgramJson({
    type: "UtteranceEnd",
    channel: [0],
    last_word_end: 1.4
  });
  assert.equal(finalOutputs.length, 1, "speech_final + UtteranceEnd must trigger exactly 1 turn");

  // (c) Duplicate identical utterance within deduplication window must be ignored
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "مساء الخير، إزيك؟", confidence: 0.98 }] }
  });
  assert.equal(finalOutputs.length, 1, "Duplicate utterance within deduplication window must not trigger a second turn");

  // (d) Silence / empty / Whisper-style hallucination phrases must not generate turns
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "", confidence: 0.0 }] }
  });
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "اشتركوا في القناة", confidence: 0.4 }] }
  });
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "...", confidence: 0.3 }] }
  });
  assert.equal(finalOutputs.length, 1, "Silence, punctuation, and hallucination phrases must be suppressed");

  // (e) Background noise where `speech_final` is false but `UtteranceEnd` fires must trigger exactly once
  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: false,
    channel: { alternatives: [{ transcript: "عايز أعرف عنوان العيادة فين", confidence: 0.91 }] }
  });
  assert.equal(finalOutputs.length, 1);
  mockSocket.emitDeepgramJson({
    type: "UtteranceEnd",
    channel: [0],
    last_word_end: 3.2
  });
  assert.equal(finalOutputs.length, 2);
  assert.equal(finalOutputs[1], "عايز أعرف عنوان العيادة فين");

  // (f) Closing the session sends `CloseStream` and blocks all subsequent audio or transcript events
  session.close();
  assert.ok(
    mockSocket.sentControlMessages.some((m) => m.type === "CloseStream"),
    "Closing session must send CloseStream to Deepgram"
  );
  const postCloseAudioSent = session.sendAudio(speechFrame.buffer, "linear16");
  assert.equal(postCloseAudioSent, false, "No audio may be sent after session close");

  mockSocket.emitDeepgramJson({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "كلام بعد قفل المكالمة", confidence: 0.99 }] }
  });
  assert.equal(finalOutputs.length, 2, "No speech may be processed after session is closed");
  console.log("[PASS] 3. Repetition, silence, background noise UtteranceEnd, and post-close lifecycle tests verified");
}

// ---------------------------------------------------------------------------
// 4. Preservation of ElevenLabs Voice ID, Conversation Guard, and Repository Integrity
// ---------------------------------------------------------------------------
{
  const agentSource = fs.readFileSync(path.join(rootDir, "src/agent.ts"), "utf8");
  const tenantSource = fs.readFileSync(path.join(rootDir, "src/lib/tenant.ts"), "utf8");
  const indexSource = fs.readFileSync(path.join(rootDir, "src/index.ts"), "utf8");

  assert.ok(!agentSource.includes("whisper-large-v3-turbo"), "Whisper STT must be removed from src/agent.ts");
  assert.ok(agentSource.includes("DeepgramStreamingSession"), "DeepgramStreamingSession must be integrated in src/agent.ts");
  assert.match(agentSource, /language:\s*"ar"\s*\n\s*}\s*\)\s*;/, "Mizan Deepgram session must force Arabic-only language after all overrides");
  assert.ok(agentSource.includes("eleven_v4_turbo"), "ElevenLabs model_id eleven_v4_turbo must be preserved");
  const { DEFAULT_MIZAN_VOICE_ID } = await loadTsModule("src/lib/tenant.ts");
  assert.equal(DEFAULT_MIZAN_VOICE_ID, "2DkHmQavK9V2UzTYrMYT", "Use the owner's selected ElevenLabs voice");
  assert.ok(indexSource.includes("body.voice_id ?? DEFAULT_MIZAN_VOICE_ID"), "New tenants use the central voice default");
  assert.ok(!indexSource.includes("audioNode.connect(audioCtx.destination)"), "Mic-to-speaker loopback must be removed from src/index.ts");
  assert.ok(!agentSource.includes("Half-duplex echo protection"), "Server must not time-gate microphone input during TTS");
  assert.ok(!agentSource.includes("agentSpeakingUntil"), "Estimated TTS duration must not suppress caller audio");
  assert.ok(agentSource.includes('command:"barge_in"'), "Deepgram speech-start events must interrupt current browser playback");
  assert.ok(indexSource.includes("echoCancellation:true"), "Browser microphone capture must request acoustic echo cancellation");
  assert.ok(!indexSource.includes("audioCtx.currentTime<playbackTime+0.25"), "Client must not block microphone frames during playback");
  assert.ok(indexSource.includes("function stopPlayback()"), "Client must stop queued playback when caller barges in");
  const wranglerConfig = fs.readFileSync(path.join(rootDir, "wrangler.toml"), "utf8");
  assert.ok(wranglerConfig.includes("2DkHmQavK9V2UzTYrMYT"), "Wrangler documentation must identify the configured ElevenLabs voice ID");
  const deployWorkflow = fs.readFileSync(path.join(rootDir, ".github/workflows/deploy.yml"), "utf8");
  assert.ok(!deployWorkflow.includes("paths:"), "Root deployment must not be restricted to obsolete nested source paths");
  assert.ok(deployWorkflow.includes("npm run release:gate"), "Production deploy workflow must run the test suite");
  assert.ok(!deployWorkflow.includes("working-directory: ./mizan-voice-gateway-v2"), "Deploy workflow must not build the obsolete nested project");

  // Verify Egyptian Arabic caller title extraction and banned-word speech sanitization still work
  const caller = extractCallerTitleAndName("مساء الخير أنا دكتور محمد من القاهرة");
  assert.equal(caller.title, "دكتور");
  assert.equal(caller.name, "محمد");
  assert.equal(caller.gender, "male");

  const sanitized = sanitizeForSpeech("أهلاً يا فندم، مع حضرتك ميزان.", {
    role: "caller",
    callerTitle: caller.title,
    callerName: caller.name,
    callerGender: caller.gender
  });
  assert.ok(!sanitized.includes("فندم") && !sanitized.includes("حضرتك"), "Banned formal words must be sanitized");
  assert.ok(sanitized.includes("يا دكتور محمد"), "Caller title and first name must be preserved");

  console.log("[PASS] 4. Requested ElevenLabs voice, tenant config and conversation guard verified");
}

// ---------------------------------------------------------------------------
// 5. Missing DEEPGRAM_API_KEY Guard Verification
// ---------------------------------------------------------------------------
{
  assert.throws(
    () => new DeepgramStreamingSession("", { onFinalTranscript: () => {} }),
    /DEEPGRAM_API_KEY secret is not configured/,
    "Missing DEEPGRAM_API_KEY must fail fast with explicit error"
  );
  console.log("[PASS] 5. Missing DEEPGRAM_API_KEY secret fail-safe guard verified");
}

// ---------------------------------------------------------------------------
// 6. Audio transport failure recovery and buffered frame retention
// ---------------------------------------------------------------------------
{
  let socketNumber = 0;
  const sockets = [];
  const statuses = [];
  const speechFrame = new Int16Array(1024).fill(5500).buffer;
  const session = new DeepgramStreamingSession('test-dg-key', {
    onFinalTranscript: () => {}, onStatus: (status) => statuses.push(status)
  }, {webSocketFactory: async () => {
    const socket = new MockDeepgramSocket();
    if (socketNumber++ === 0) {
      const originalSend = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data !== 'string') throw new Error('simulated binary transport failure');
        originalSend(data);
      };
    }
    sockets.push(socket);
    return socket;
  }});
  await session.connect();
  // Deliberate failure injection; suppress expected noisy stack traces from a data-URL test module.
  const previousErrorLog = console.error;
  let sentSuccessfully;
  try {
    console.error = () => {};
    sentSuccessfully = session.sendAudio(speechFrame);
  } finally {
    console.error = previousErrorLog;
  }
  assert.equal(sentSuccessfully, false, 'Failed frames must not count as delivered');
  assert.equal(session.pendingAudioQueue.length,1,'Unsent voice audio must be buffered');
  assert.ok(statuses.includes('reconnecting'),'Browser receives reconnecting status');
  assert.equal(sockets[0].closed,true,'Broken WebSocket closes');
  await session.connect();
  assert.equal(sockets[1].sentBinaryFrames.length,1,'Buffered speech is replayed on reconnect');
  assert.equal(session.pendingAudioQueue.length,0);
  session.close();
  assert.equal(session.sendAudio(speechFrame), false, 'Post-close frames must still be blocked');

  const initialBuffered = new DeepgramStreamingSession('test-dg-key', {
    onFinalTranscript: () => {}, onStatus: (status) => statuses.push(status)
  }, {webSocketFactory: async () => {
    const socket = new MockDeepgramSocket();
    socket.send = data => {if(typeof data !== 'string') throw new Error('failed queued write');};
    return socket;
  }});
  assert.equal(initialBuffered.sendAudio(speechFrame),false,'Audio buffered while connecting');
  assert.equal(initialBuffered.pendingAudioQueue.length,1);
  await initialBuffered.connect();
  assert.equal(initialBuffered.pendingAudioQueue.length,1,'Queued voice chunks must survive failed flush');
  initialBuffered.close();
  console.log('[PASS] 6. STT binary send failure triggers reconnect, buffers/replays audio, and retains unsent frames');
}

console.log("=== ALL TESTS PASSED SUCCESSFULLY ===");
