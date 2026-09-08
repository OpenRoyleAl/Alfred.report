// app.js — Alfred Command Center frontend logic (v2 with COP Map)

const API = "/api";
const WS_URL = `wss://${location.hostname === "voice.alfred.report" ? "voice.alfred.report" : location.hostname}/ws`;

let voiceWs = null;
let mediaRecorder = null;
let audioContext = null;
let currentUserId = "user-" + (localStorage.getItem("alfred-user-id") || crypto.randomUUID());
localStorage.setItem("alfred-user-id", currentUserId);

// --- Navigation ---
document.querySelectorAll(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`view-${btn.dataset.view}`).classList.add("active");

    if (btn.dataset.view === "dashboard") loadDashboard();
    if (btn.dataset.view === "missions") loadMissions();
    if (btn.dataset.view === "reports") loadReports();
    if (btn.dataset.view === "cop") loadCopMap();
    if (btn.dataset.view === "settings") loadSettings();
  });
});

// --- Health Check ---
async function checkHealth() {
  const el = document.getElementById("health-status");
  try {
    const res = await fetch(`${API}/health`);
    const data = await res.json();
    el.textContent = `● ${data.status} — ${data.tts_provider}`;
    el.className = "health-status ok";
  } catch {
    el.textContent = "● Offline";
    el.className = "health-status error";
  }
}

// --- Dashboard ---
async function loadDashboard() {
  try {
    const [missionsRes, memoryRes] = await Promise.all([
      fetch(`${API}/missions?user_id=${currentUserId}`),
      fetch(`${API}/memory/summary`),
    ]);
    const missions = await missionsRes.json();
    const memory = await memoryRes.json();

    const active = missions.filter(m => m.status === "active").length;
    const completed = missions.filter(m => m.status === "completed").length;
    const failed = missions.filter(m => m.status === "failed").length;

    document.getElementById("stats-grid").innerHTML = `
      <div class="stat-card"><div class="stat-value">${missions.length}</div><div class="stat-label">Total Missions</div></div>
      <div class="stat-card"><div class="stat-value">${active}</div><div class="stat-label">Active</div></div>
      <div class="stat-card"><div class="stat-value">${completed}</div><div class="stat-label">Completed</div></div>
      <div class="stat-card"><div class="stat-value">${failed}</div><div class="stat-label">Failed</div></div>
    `;

    const recent = missions.slice(0, 5);
    document.getElementById("recent-missions").innerHTML = recent.length
      ? recent.map(m => renderMission(m)).join("")
      : '<div class="empty-state">No missions yet</div>';

    document.getElementById("memory-summary").innerHTML =
      memory.summary ? `<div>${escapeHtml(memory.summary)}</div>` : '<div class="muted">No memories stored yet</div>';
  } catch (err) {
    console.error("Dashboard error:", err);
  }
}

// --- Missions ---
async function loadMissions() {
  try {
    const res = await fetch(`${API}/missions?user_id=${currentUserId}`);
    const missions = await res.json();
    document.getElementById("missions-list").innerHTML = missions.length
      ? missions.map(m => renderMission(m)).join("")
      : '<div class="empty-state">No missions yet. Create one to get started.</div>';
  } catch (err) {
    console.error("Missions error:", err);
  }
}

function renderMission(m) {
  return `
    <div class="mission-item">
      <div class="mission-info">
        <h4>${escapeHtml(m.title)}</h4>
        <p>${m.description ? escapeHtml(m.description) : "No description"} · Priority ${m.priority}${m.budget_usd ? ` · Budget $${m.budget_usd}` : ""}</p>
      </div>
      <div class="mission-status ${m.status}">${m.status}</div>
    </div>
  `;
}

// New Mission Modal
document.getElementById("btn-new-mission").addEventListener("click", () => {
  document.getElementById("modal-new-mission").classList.remove("hidden");
});

document.getElementById("btn-cancel-mission").addEventListener("click", () => {
  document.getElementById("modal-new-mission").classList.add("hidden");
});

document.getElementById("btn-create-mission").addEventListener("click", async () => {
  const title = document.getElementById("mission-title").value.trim();
  if (!title) return;

  try {
    await fetch(`${API}/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: currentUserId,
        title,
        description: document.getElementById("mission-description").value.trim() || undefined,
        priority: parseInt(document.getElementById("mission-priority").value) || 5,
        budget_usd: parseFloat(document.getElementById("mission-budget").value) || undefined,
      }),
    });

    document.getElementById("mission-title").value = "";
    document.getElementById("mission-description").value = "";
    document.getElementById("mission-budget").value = "";
    document.getElementById("modal-new-mission").classList.add("hidden");
    loadMissions();
  } catch (err) {
    console.error("Create mission error:", err);
    alert("Failed to create mission");
  }
});

// --- Voice ---
const btnConnect = document.getElementById("btn-connect-voice");
const btnMic = document.getElementById("btn-mic");
const indicator = document.getElementById("voice-indicator");
const statusText = document.getElementById("voice-status-text");
const transcriptEl = document.getElementById("transcript");
const textInput = document.getElementById("text-input");
const btnSendText = document.getElementById("btn-send-text");

btnConnect.addEventListener("click", toggleVoiceConnection);
btnMic.addEventListener("click", toggleMic);
btnSendText.addEventListener("click", sendText);
textInput.addEventListener("keypress", (e) => { if (e.key === "Enter") sendText(); });

function toggleVoiceConnection() {
  if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
    voiceWs.close();
    return;
  }

  const sessionId = crypto.randomUUID();
  voiceWs = new WebSocket(`${WS_URL}/${sessionId}?user_id=${currentUserId}`);

  voiceWs.onopen = () => {
    indicator.className = "voice-indicator connected";
    statusText.textContent = "Connected";
    btnConnect.textContent = "Disconnect";
    btnMic.disabled = false;
  };

  voiceWs.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      playAudio(event.data);
    } else {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "transcript") {
          addTranscript("user", msg.text);
        } else if (msg.type === "response") {
          addTranscript("alfred", msg.text);
          indicator.className = "voice-indicator speaking";
          setTimeout(() => indicator.className = "voice-indicator connected", 500);
        } else if (msg.type === "error") {
          addTranscript("system", `Error: ${msg.message}`);
        }
      } catch {}
    }
  };

  voiceWs.onclose = () => {
    indicator.className = "voice-indicator";
    statusText.textContent = "Disconnected";
    btnConnect.textContent = "Connect";
    btnMic.disabled = true;
    if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  };

  voiceWs.onerror = () => {
    statusText.textContent = "Connection error";
    indicator.className = "voice-indicator";
  };
}

async function toggleMic() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    btnMic.textContent = "🎤 Start Speaking";
    indicator.className = "voice-indicator connected";
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0 && voiceWs.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then(buf => voiceWs.send(buf));
      }
    };

    mediaRecorder.start(100);
    btnMic.textContent = "⏹ Stop Speaking";
    indicator.className = "voice-indicator speaking";
  } catch (err) {
    console.error("Mic error:", err);
    alert("Microphone access denied or unavailable");
  }
}

function sendText() {
  const text = textInput.value.trim();
  if (!text || !voiceWs || voiceWs.readyState !== WebSocket.OPEN) return;
  voiceWs.send(text);
  addTranscript("user", text);
  textInput.value = "";
}

function addTranscript(speaker, text) {
  const entry = document.createElement("div");
  entry.className = `transcript-entry ${speaker}`;
  entry.innerHTML = `<div class="speaker">${speaker === "user" ? "You" : speaker === "alfred" ? "Alfred" : "System"}</div><div class="text">${escapeHtml(text)}</div>`;
  transcriptEl.appendChild(entry);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function playAudio(buffer) {
  if (!audioContext) audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(buffer);
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  source.start();
}

// --- Reports ---
document.getElementById("btn-refresh-reports").addEventListener("click", loadReports);

async function loadReports() {
  try {
    const res = await fetch(`${API}/reports?user_id=${currentUserId}`);
    const reports = await res.json();
    const list = document.getElementById("reports-list");
    list.innerHTML = reports.length
      ? reports.map(r => `
        <div class="report-item">
          <h4>${escapeHtml(r.title || r.mission_id || "Report")}</h4>
          <p>${escapeHtml(r.summary || r.status || "No summary")}</p>
        </div>
      `).join("")
      : '<div class="empty-state">No reports available</div>';
  } catch (err) {
    console.error("Reports error:", err);
    document.getElementById("reports-list").innerHTML = '<div class="empty-state">Failed to load reports</div>';
  }
}

// --- COP Map ---
document.getElementById("btn-refresh-cop").addEventListener("click", loadCopMap);

async function loadCopMap() {
  try {
    const [overview, burn, missions, agents, voice, gateway, memory] = await Promise.all([
      fetch(`${API}/cop/overview`).then(r => r.json()),
      fetch(`${API}/cop/burn-rate`).then(r => r.json()),
      fetch(`${API}/cop/missions`).then(r => r.json()),
      fetch(`${API}/cop/agents`).then(r => r.json()),
      fetch(`${API}/cop/voice`).then(r => r.json()),
      fetch(`${API}/cop/gateway`).then(r => r.json()),
      fetch(`${API}/cop/memory`).then(r => r.json()),
    ]);

    document.getElementById("cop-stats").innerHTML = `
      <div class="stat-card"><div class="stat-value">${overview.active_missions}</div><div class="stat-label">Active Missions</div></div>
      <div class="stat-card"><div class="stat-value">$${overview.cost_today_usd?.toFixed(2) ?? "0.00"}</div><div class="stat-label">Cost Today</div></div>
      <div class="stat-card"><div class="stat-value">${overview.active_voice_sessions}</div><div class="stat-label">Voice Sessions</div></div>
      <div class="stat-card"><div class="stat-value">${burn.reduce((s, b) => s + (b.burn_per_min || 0), 0).toFixed(0)}</div><div class="stat-label">Tokens/min</div></div>
    `;

    document.getElementById("cop-burn-rate").innerHTML = burn.length
      ? burn.map(b => `<div class="report-item"><h4>${escapeHtml(b.agent)}</h4><p>${b.tokens} tokens · ${b.burn_per_min?.toFixed(1)} tokens/min</p></div>`).join("")
      : '<div class="empty-state">No burn data in last hour</div>';

    document.getElementById("cop-missions").innerHTML = missions.length
      ? missions.map(m => `<div class="report-item"><h4>${escapeHtml(m.mission_id)}</h4><p>$${m.total_cost_usd?.toFixed(4)} · ${m.total_tokens_in + m.total_tokens_out} tokens · ${m.ai_calls} AI calls</p></div>`).join("")
      : '<div class="empty-state">No mission cost data</div>';

    document.getElementById("cop-agents").innerHTML = agents.length
      ? agents.map(a => `<div class="report-item"><h4>${escapeHtml(a.agent)}</h4><p>${a.calls} calls · $${a.cost_usd?.toFixed(4)}</p></div>`).join("")
      : '<div class="empty-state">No agent activity in last 24h</div>';

    document.getElementById("cop-voice").innerHTML = voice.length
      ? voice.map(v => `<div class="report-item"><h4>${escapeHtml(v.status)}</h4><p>${v.n} sessions · ${v.total_seconds}s total</p></div>`).join("")
      : '<div class="empty-state">No voice sessions</div>';

    document.getElementById("cop-gateway").innerHTML = gateway.length
      ? gateway.map(g => `<div class="report-item"><h4>${escapeHtml(g.provider)} / ${escapeHtml(g.model)}</h4><p>${g.calls} calls · $${g.cost_usd?.toFixed(4)}</p></div>`).join("")
      : '<div class="empty-state">No gateway usage in last 24h</div>';

    document.getElementById("cop-memory").innerHTML = `
      <div class="report-item"><h4>KV (alfred-command)</h4><p>${memory.kv_keys} keys</p></div>
      <div class="report-item"><h4>D1 (alfred-db)</h4><p>${memory.d1_rows} rows</p></div>
      <div class="report-item"><h4>Agent Memory (alfred)</h4><p>Managed by Cloudflare Agent Memory</p></div>
    `;
  } catch (err) {
    console.error("COP Map error:", err);
  }
}

// --- Settings ---
async function loadSettings() {
  try {
    const res = await fetch(`${API}/oral/preferences?user_id=${currentUserId}`);
    if (res.ok) {
      const prefs = await res.json();
      if (prefs.tts_provider) document.getElementById("tts-provider-select").value = prefs.tts_provider;
      if (prefs.stt_provider) document.getElementById("stt-provider-select").value = prefs.stt_provider;
      if (prefs.voice_model) document.getElementById("voice-model-select").value = prefs.voice_model;
    }
  } catch {}
}

document.getElementById("btn-save-settings").addEventListener("click", async () => {
  const prefs = {
    tts_provider: document.getElementById("tts-provider-select").value,
    stt_provider: document.getElementById("stt-provider-select").value,
    voice_model: document.getElementById("voice-model-select").value,
  };

  try {
    await fetch(`${API}/oral/preferences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: currentUserId, ...prefs }),
    });
    alert("Settings saved");
  } catch (err) {
    alert("Failed to save settings");
  }
});

document.getElementById("btn-upload-voice").addEventListener("click", async () => {
  const fileInput = document.getElementById("voice-sample-upload");
  const statusEl = document.getElementById("upload-status");
  if (!fileInput.files[0]) {
    statusEl.textContent = "Please select a file first";
    statusEl.className = "upload-status error";
    return;
  }

  const formData = new FormData();
  formData.append("voice_sample", fileInput.files[0]);

  try {
    statusEl.textContent = "Uploading...";
    statusEl.className = "upload-status";
    const res = await fetch(`${API}/voice-samples/upload?user_id=${currentUserId}`, {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    if (data.success) {
      statusEl.textContent = `Uploaded: ${data.r2_key}`;
      statusEl.className = "upload-status success";
    } else {
      statusEl.textContent = data.error || "Upload failed";
      statusEl.className = "upload-status error";
    }
  } catch (err) {
    statusEl.textContent = "Upload failed";
    statusEl.className = "upload-status error";
  }
});

// --- Utility ---
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

// --- Init ---
checkHealth();
loadDashboard();
setInterval(checkHealth, 30000);