// ============================================================================
// Mizan Voice Studio Frontend Controller (`public/js/studio.js`)
// ============================================================================
// Uses safe DOM construction (`textContent`) everywhere to prevent XSS,
// connects to the real gateway voice ticket + AudioWorklet pipeline, and
// supports immutable version activation and HMAC-signed release export.
// ============================================================================

(function () {
  var ws = null;
  var audioCtx = null;
  var mediaStream = null;
  var workletNode = null;
  var playbackSources = new Set();
  var playbackTime = 0;
  var playbackEpoch = 0;
  var studioState = {
    harnessUrl: "",
    lockedLayers: { globalSystemPrompt: "", defaultVoiceId: "2DkHmQavK9V2UzTYrMYT", industryGuards: {} },
    agents: []
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function appendChat(role, text) {
    var box = byId("chatBox");
    if (!box) return;
    var row = document.createElement("div");
    row.className = "msg";
    var strong = document.createElement("strong");
    strong.textContent = role + ":";
    var span = document.createElement("span");
    span.textContent = " " + String(text || "");
    row.appendChild(strong);
    row.appendChild(span);
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }

  function showTab(name) {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === name);
    }
    var ids = ["builder", "playground", "gates", "traces"];
    for (var j = 0; j < ids.length; j++) {
      var panel = byId("tab-" + ids[j]);
      if (panel) panel.classList.toggle("hidden", ids[j] !== name);
    }
  }

  function openHarness() {
    var target = studioState.harnessUrl || (location.protocol + "//opencode-harness-example." + location.host.split(".").slice(1).join("."));
    window.open(target, "_blank", "noopener,noreferrer");
  }

  function updateLockedPreview() {
    var ind = byId("industry") ? byId("industry").value : "general";
    var guard = (studioState.lockedLayers.industryGuards && studioState.lockedLayers.industryGuards[ind]) || "No additional sector restriction.";
    var preview = byId("lockedPromptPreview");
    if (preview) {
      preview.value = "[Global Identity] " + (studioState.lockedLayers.globalSystemPrompt || "") + "\n[Industry Guard (" + ind + ")] " + guard;
    }
  }

  function syncBuilderFieldsForTenant(tenantId) {
    var found = null;
    for (var i = 0; i < studioState.agents.length; i++) {
      if (studioState.agents[i].tenant_id === tenantId) {
        found = studioState.agents[i];
        break;
      }
    }
    if (!found) return;
    if (byId("industry")) byId("industry").value = found.industry || "general";
    if (byId("voiceId")) byId("voiceId").value = found.voice_id || "2DkHmQavK9V2UzTYrMYT";
    if (byId("systemPrompt")) byId("systemPrompt").value = found.tenant_customization || "";
    if (byId("knowledgeText")) byId("knowledgeText").value = found.knowledge_text || "";

    var verSel = byId("versionSelect");
    if (verSel) {
      verSel.textContent = "";
      var versions = Array.isArray(found.versions) && found.versions.length ? found.versions : [found.active_version || 1];
      for (var k = 0; k < versions.length; k++) {
        var v = versions[k];
        var opt = document.createElement("option");
        opt.value = String(v);
        opt.textContent = "v" + v + (v === found.active_version ? " (active)" : "");
        if (v === found.active_version) opt.selected = true;
        verSel.appendChild(opt);
      }
    }
    updateLockedPreview();
  }

  function renderGates(gates) {
    var container = byId("gatesList");
    if (!container) return;
    container.textContent = "";
    var list = Array.isArray(gates) ? gates : [];
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      var row = document.createElement("div");
      row.className = "gate";

      var left = document.createElement("div");
      var title = document.createElement("div");
      title.textContent = g.title;
      var detail = document.createElement("div");
      detail.className = "sub";
      detail.textContent = g.detail || "";
      left.appendChild(title);
      left.appendChild(detail);

      var badge = document.createElement("span");
      badge.className = "pill " + (g.status === "PASSED" ? "live" : g.status === "WARN" ? "dev" : "fail");
      badge.textContent = g.status;

      row.appendChild(left);
      row.appendChild(badge);
      container.appendChild(row);
    }
  }

  function renderTraces(traces) {
    var tbody = byId("tracesTable");
    if (!tbody) return;
    tbody.textContent = "";
    var list = Array.isArray(traces) ? traces : [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var tr = document.createElement("tr");

      var violations = [];
      try {
        violations = JSON.parse(t.guard_violations_json || "[]");
      } catch (_e) {
        violations = [];
      }

      var cells = [
        String(t.call_id || "").slice(0, 8) + "...",
        String(t.tenant_id || ""),
        String(t.environment || "staging"),
        String(t.runtime_version || ""),
        "v" + String(t.config_version || 1),
        String(t.llm_ttft_ms || 0) + " ms",
        String(t.tts_ttfb_ms || 0) + " ms",
        String(Array.isArray(violations) ? violations.length : 0),
        String(t.barge_ins || 0)
      ];

      for (var c = 0; c < cells.length; c++) {
        var td = document.createElement("td");
        td.textContent = cells[c];
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  async function refreshAll() {
    try {
      var res = await fetch("/api/ops/status");
      var data = await res.json();
      if (!data.ok) return;

      studioState.harnessUrl = data.harnessUrl || "";
      studioState.lockedLayers = data.lockedLayers || studioState.lockedLayers;
      studioState.agents = Array.isArray(data.agents) ? data.agents : [];

      if (byId("revBadge")) byId("revBadge").textContent = "Runtime: " + data.runtimeVersion;
      if (byId("agentCount")) byId("agentCount").textContent = studioState.agents.length + " Agents";

      var sel = byId("testTenantSelect");
      if (sel) {
        var previous = sel.value;
        sel.textContent = "";
        for (var i = 0; i < studioState.agents.length; i++) {
          var a = studioState.agents[i];
          var opt = document.createElement("option");
          opt.value = a.tenant_id;
          opt.textContent = a.tenant_id + " — " + a.name + " (" + a.industry + " · v" + a.active_version + ")";
          if (a.tenant_id === previous) opt.selected = true;
          sel.appendChild(opt);
        }
      }

      var currentTenantId = byId("tenantId") ? byId("tenantId").value.trim() : "";
      syncBuilderFieldsForTenant(currentTenantId);
      renderGates(data.gates);
      renderTraces(data.traces);
    } catch (err) {
      appendChat("System", "Failed to load Studio status: " + (err && err.message ? err.message : String(err)));
    }
  }

  async function publishAgent() {
    var tenantId = byId("tenantId").value.trim();
    var res = await fetch("/api/ops/agents/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: tenantId,
        industry: byId("industry").value,
        voiceId: byId("voiceId").value.trim(),
        tenantCustomization: byId("systemPrompt").value,
        knowledgeText: byId("knowledgeText").value
      })
    });
    var data = await res.json();
    alert(data.ok ? ("Published " + data.tenantId + " @ v" + data.activeVersion) : (data.error || "Publish failed"));
    await refreshAll();
  }

  async function activateSelectedVersion() {
    var tenantId = byId("tenantId").value.trim();
    var version = Number(byId("versionSelect").value || 1);
    var res = await fetch("/api/ops/agents/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantId, version: version })
    });
    var data = await res.json();
    alert(data.ok ? ("Activated " + tenantId + " @ v" + data.activeVersion) : (data.error || "Activation failed"));
    await refreshAll();
  }

  async function rollbackAgent() {
    var tenantId = byId("tenantId").value.trim();
    var res = await fetch("/api/ops/agents/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantId })
    });
    var data = await res.json();
    alert(data.ok ? ("Rolled back " + tenantId + " to v" + data.activeVersion) : (data.error || "Rollback failed"));
    await refreshAll();
  }

  async function exportPromotionBundle() {
    var tenantId = byId("tenantId").value.trim();
    var version = byId("versionSelect").value || "";
    var res = await fetch("/api/ops/agents/export?tenantId=" + encodeURIComponent(tenantId) + "&version=" + encodeURIComponent(version));
    var data = await res.json();
    if (!data.ok) {
      alert(data.error || "Failed to export release bundle");
      return;
    }
    var box = byId("bundleBox");
    var out = byId("bundleOutput");
    if (box && out) {
      box.classList.remove("hidden");
      out.value = JSON.stringify(data.bundle, null, 2);
    }
  }

  async function sendTextTurn() {
    var input = byId("simInput");
    var message = input ? input.value.trim() : "";
    if (!message) return;
    input.value = "";
    var tenantId = byId("testTenantSelect").value;
    appendChat("You", message);

    var res = await fetch("/api/ops/agents/simulate-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantId, message: message })
    });
    var data = await res.json();
    if (!data.ok) {
      appendChat("Error", data.error || "Turn simulation failed");
      return;
    }
    if (data.scrubbedInput && data.scrubbedInput !== message) {
      appendChat("PII Scrubber", "Redacted input -> " + data.scrubbedInput);
    }
    if (Array.isArray(data.guardViolations) && data.guardViolations.length > 0) {
      appendChat("Arabic Output Guard", "Stripped/flagged -> " + data.guardViolations.join(", "));
    }
    appendChat("Agent (v" + data.configVersion + " · " + data.latencyMs + "ms · " + data.state + ")", data.reply);
    await refreshAll();
  }

  async function runGatesCheck() {
    var res = await fetch("/api/ops/gates/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    var data = await res.json();
    if (data.gates) {
      renderGates(data.gates);
      alert(data.ok ? "All Studio CI/CD quality gates passed." : "One or more quality gates reported issues.");
    }
  }

  function stopPlayback() {
    playbackEpoch++;
    playbackSources.forEach(function (src) {
      try { src.stop(); } catch (_e) {}
    });
    playbackSources.clear();
    playbackTime = audioCtx ? audioCtx.currentTime : 0;
    if (byId("bargeInBtn")) byId("bargeInBtn").hidden = true;
  }

  async function playMp3Audio(arrayBuffer) {
    if (!audioCtx) return;
    var epoch = playbackEpoch;
    if (byId("bargeInBtn")) byId("bargeInBtn").hidden = false;
    try {
      if (audioCtx.state === "suspended") await audioCtx.resume();
      var decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      if (epoch !== playbackEpoch || !ws) return;
      var src = audioCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(audioCtx.destination);
      var startAt = Math.max(audioCtx.currentTime, playbackTime);
      playbackSources.add(src);
      src.onended = function () {
        playbackSources.delete(src);
        if (playbackSources.size === 0 && byId("bargeInBtn")) {
          byId("bargeInBtn").hidden = true;
        }
      };
      src.start(startAt);
      playbackTime = startAt + decoded.duration;
    } catch (err) {
      appendChat("Audio Error", "Failed to decode/play MP3 response: " + (err && err.message ? err.message : String(err)));
    }
  }

  function endLiveCall() {
    stopPlayback();
    if (ws) {
      try { ws.close(); } catch (_e) {}
      ws = null;
    }
    if (workletNode) {
      try { workletNode.disconnect(); } catch (_e) {}
      workletNode = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (_e) {}
      audioCtx = null;
    }
    if (byId("micBtn")) byId("micBtn").textContent = "Start Live WebSocket Session (Mic)";
    if (byId("callStatus")) byId("callStatus").textContent = "Disconnected";
    setTimeout(refreshAll, 350);
  }

  async function toggleMicCall() {
    if (ws) {
      endLiveCall();
      return;
    }

    var tenantId = byId("testTenantSelect").value;
    if (!tenantId) return;

    try {
      byId("callStatus").textContent = "Requesting Signed Ticket...";
      var tokenRes = await fetch("/api/voice/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: tenantId })
      });
      var tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.call_token || !tokenData.session_id) {
        appendChat("Auth Gate", tokenData.error || "Could not obtain signed call ticket");
        byId("callStatus").textContent = "Ticket Denied";
        return;
      }

      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      await audioCtx.audioWorklet.addModule("/pcm-processor.js");
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });

      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      var wsUrl =
        proto +
        "//" +
        location.host +
        "/agents/mizan-voice-agent/" +
        encodeURIComponent(tenantId) +
        "?session_id=" +
        encodeURIComponent(tokenData.session_id) +
        "&call_token=" +
        encodeURIComponent(tokenData.call_token);

      ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      ws.onopen = function () {
        byId("micBtn").textContent = "End Live Session";
        byId("callStatus").textContent = "Live DO Connected";
        appendChat("WebSocket", "Connected to MizanVoiceAgent DO (" + tenantId + " · session " + tokenData.session_id.slice(0, 8) + ")");

        ws.send(JSON.stringify({ type: "audio_config", format: "linear16", sampleRate: 16000, channels: 1 }));
        var source = audioCtx.createMediaStreamSource(mediaStream);
        workletNode = new AudioWorkletNode(audioCtx, "pcm-linear16-processor");
        var silentSink = audioCtx.createGain();
        silentSink.gain.value = 0;
        workletNode.port.onmessage = function (evt) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(evt.data);
          }
        };
        source.connect(workletNode);
        workletNode.connect(silentSink);
        silentSink.connect(audioCtx.destination);
      };

      ws.onmessage = function (evt) {
        if (evt.data instanceof ArrayBuffer) {
          playMp3Audio(evt.data);
          return;
        }
        try {
          var msg = JSON.parse(evt.data);
          if (msg.type === "transcript") {
            if (msg.speaker === "caller") stopPlayback();
            appendChat(msg.speaker === "caller" ? "Caller (STT)" : "Agent", msg.text);
          } else if (msg.type === "error") {
            appendChat("Voice Error", msg.message || "Voice error");
          }
        } catch (_e) {}
      };

      ws.onclose = function () {
        if (ws) endLiveCall();
      };
    } catch (err) {
      appendChat("Mic / Session Notice", err && err.message ? err.message : String(err));
      endLiveCall();
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    appendChat(
      "Studio",
      "Select an agent above and send a test message (include a sample Egyptian mobile like 01012345678 to verify live PII redaction, Arabic output guard, and versioned trace logging)."
    );

    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function (evt) {
        showTab(evt.currentTarget.getAttribute("data-tab"));
      });
    }

    if (byId("openHarnessBtn")) byId("openHarnessBtn").addEventListener("click", openHarness);
    if (byId("openHarnessGatesBtn")) byId("openHarnessGatesBtn").addEventListener("click", openHarness);
    if (byId("syncBtn")) byId("syncBtn").addEventListener("click", refreshAll);
    if (byId("publishBtn")) byId("publishBtn").addEventListener("click", publishAgent);
    if (byId("activateVerBtn")) byId("activateVerBtn").addEventListener("click", activateSelectedVersion);
    if (byId("rollbackBtn")) byId("rollbackBtn").addEventListener("click", rollbackAgent);
    if (byId("exportBundleBtn")) byId("exportBundleBtn").addEventListener("click", exportPromotionBundle);
    if (byId("sendTurnBtn")) byId("sendTurnBtn").addEventListener("click", sendTextTurn);
    if (byId("runGatesBtn")) byId("runGatesBtn").addEventListener("click", runGatesCheck);
    if (byId("micBtn")) byId("micBtn").addEventListener("click", toggleMicCall);
    if (byId("bargeInBtn")) byId("bargeInBtn").addEventListener("click", stopPlayback);
    if (byId("industry")) byId("industry").addEventListener("change", updateLockedPreview);
    if (byId("tenantId")) {
      byId("tenantId").addEventListener("change", function (e) {
        syncBuilderFieldsForTenant(e.target.value.trim());
      });
    }
    if (byId("simInput")) {
      byId("simInput").addEventListener("keydown", function (e) {
        if (e.key === "Enter") sendTextTurn();
      });
    }

    refreshAll();
  });
})();
