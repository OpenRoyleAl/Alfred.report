// app.js — Alfred Command Center frontend logic (v2 with COP Map)

const API = "/api";
const WS_URL = `wss://${location.hostname === "voice.alfred.report" ? "voice.alfred.report" : location.hostname}/ws`;

let voiceWs = null;
let mediaRecorder = null;
let audioContext = null;
let currentUserId = "user-" + (localStorage.getItem("alfred-user-id") || crypto.randomUUID());
localStorage.setItem("alfred-user-id", currentUserId);

async function ensureAccess() {
  const gate = document.getElementById("access-gate");
  const app = document.getElementById("app");
  const banner = document.getElementById("siri-banner");
  const siriBtn = document.getElementById("btn-siri");
  try {
    const res = await fetch(`${API}/me`, { credentials: "include", headers: { Accept: "application/json" } });
    if (res.ok) {
      const me = await res.json();
      currentUserId = me.user_id || me.email || currentUserId;
      localStorage.setItem("alfred-user-id", currentUserId);
      if (siriBtn && me.shortcuts_url) siriBtn.href = me.shortcuts_url;
      if (banner) banner.hidden = false;
      gate.hidden = true;
      app.hidden = false;
      return true;
    }
  } catch {}
  const hosted = location.hostname.endsWith("alfred.report") || location.hostname.includes("command-os-review");
  if (!hosted) {
    gate.hidden = true;
    app.hidden = false;
    return true;
  }
  gate.hidden = false;
  app.hidden = true;
  return false;
}

document.querySelectorAll(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!btn.dataset.view) return;
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

async function checkHealth() {
  const el = document.getElementById("health-status");
  try {
    const res = await fetch(`${API}/health`);
    const data = await res.json();
    el.textContent = `${data.status} — ${data.tts_provider}`;
    el.className = "health-status ok";
  } catch {
    el.textContent = "Offline";
    el.className = "health-status error";
  }
}

function copCell(title, meta, status) {
  return `<div class="cop-cell status-${status || "idle"}"><h4>${escapeHtml(title)}</h4><p>${escapeHtml(meta)}</p></div>`;
}

async function loadDashboard() {
  const stats = document.getElementById("stats-grid");
  stats.innerHTML = `
    <div class="stat-card"><div class="stat-value">0</div><div class="stat-label">Missions</div></div>
    <div class="stat-card"><div class="stat-value">0</div><div class="stat-label">Voice sessions</div></div>
    <div class="stat-card"><div class="stat-value">$0.00</div><div class="stat-label">Cost today</div></div>
    <div class="stat-card"><div class="stat-value">0/0/0</div><div class="stat-label">Active / done / failed</div></div>
  `;
  try {
    const [missionsRes, memoryRes, overview] = await Promise.all([
      fetch(`${API}/missions?user_id=${currentUserId}`),
      fetch(`${API}/memory/summary`),
      jsonOrEmpty(`${API}/cop/overview`),
    ]);
    const missions = await missionsRes.json();
    const memory = await memoryRes.json();
    const agents = asArray(await jsonOrEmpty(`${API}/cop/agents`));

    const active = missions.filter(m => m.status === "active").length;
    const completed = missions.filter(m => m.status === "completed").length;
    const failed = missions.filter(m => m.status === "failed").length;

    document.getElementById("stats-grid").innerHTML = `
      <div class="stat-card"><div class="stat-value">${missions.length}</div><div class="stat-label">Missions</div></div>
      <div class="stat-card"><div class="stat-value">${overview.active_voice_sessions ?? 0}</div><div class="stat-label">Voice sessions</div></div>
      <div class="stat-card"><div class="stat-value">$${(overview.cost_today_usd ?? 0).toFixed(2)}</div><div class="stat-label">Cost today</div></div>
      <div class="stat-card"><div class="stat-value">${active}/${completed}/${failed}</div><div class="stat-label">Active / done / failed</div></div>
    `;

    const recent = missions.slice(0, 5);
    document.getElementById("recent-missions").innerHTML = recent.length
      ? recent.map(m => renderMissionRow(m)).join("")
      : '<div class="empty-state">No missions yet</div>';

    const mini = [];
    mini.push(copCell("Active missions", String(overview.active_missions ?? active), (overview.active_missions || active) ? "live" : "idle"));
    mini.push(copCell("Voice", `${overview.active_voice_sessions ?? 0} sessions`, overview.active_voice_sessions ? "ok" : "idle"));
    mini.push(copCell("Spend", `$${(overview.cost_today_usd ?? 0).toFixed(4)}`, (overview.cost_today_usd || 0) > 0 ? "warn" : "idle"));
    agents.slice(0, 4).forEach(a => {
      mini.push(copCell(a.agent, `${a.calls} calls · $${(a.cost_usd ?? 0).toFixed(4)}`, a.calls > 0 ? "ok" : "idle"));
    });
    document.getElementById("cop-mini").innerHTML = mini.join("") || '<div class="empty-state">Nothing on the map</div>';

    document.getElementById("memory-summary").innerHTML =
      memory.summary ? `<div>${escapeHtml(memory.summary)}</div>` : '<div class="muted">No memories stored yet</div>';
  } catch (err) {
    console.error("Dashboard error:", err);
  }
}

async function loadMissions() {
  try {
    const res = await fetch(`${API}/missions?user_id=${currentUserId}`);
    const missions = await res.json();
    document.getElementById("missions-list").innerHTML = missions.length
      ? renderMissionTable(missions)
      : '<div class="empty-state">No missions yet. Create one to get started.</div>';
  } catch (err) {
    console.error("Missions error:", err);
  }
}

function missionActions(m) {
  return m.status === "pending" || m.status === "paused"
    ? `<button class="btn btn-primary btn-small" data-action="execute" data-id="${m.id}">Execute</button>`
    : m.status === "active"
      ? `<button class="btn btn-primary btn-small" data-action="execute" data-id="${m.id}">Finish</button>`
      : m.status === "completed"
        ? `<button class="btn btn-secondary btn-small" data-action="status" data-id="${m.id}">Status</button>`
        : "";
}

function renderMissionRow(m) {
  return `
    <div class="mission-item">
      <div class="mission-info">
        <h4>${escapeHtml(m.title)}</h4>
        <p>${m.description ? escapeHtml(m.description) : "No description"} · Priority ${m.priority}${m.budget_usd ? ` · Budget $${m.budget_usd}` : ""}</p>
      </div>
      <div class="mission-meta">
        <div class="mission-status ${m.status}">${m.status}</div>
        ${missionActions(m)}
      </div>
    </div>
  `;
}

function renderMissionTable(missions) {
  const rows = missions.map(m => `
    <tr>
      <td>
        <div class="cell-title">${escapeHtml(m.title)}</div>
        <div class="cell-meta">${m.description ? escapeHtml(m.description) : "No description"}</div>
      </td>
      <td class="cell-data">${m.priority}</td>
      <td class="cell-data">${m.budget_usd ? `$${m.budget_usd}` : "—"}</td>
      <td><div class="mission-status ${m.status}">${m.status}</div></td>
      <td>${missionActions(m)}</td>
    </tr>
  `).join("");
  return `
    <table class="mission-table">
      <thead>
        <tr>
          <th>Mission</th>
          <th>Priority</th>
          <th>Budget</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMission(m) {
  return renderMissionRow(m);
}

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
    loadDashboard();
  } catch (err) {
    console.error("Create mission error:", err);
    alert("Failed to create mission");
  }
});

document.getElementById("missions-list").addEventListener("click", handleMissionAction);
document.getElementById("recent-missions").addEventListener("click", handleMissionAction);

async function handleMissionAction(event) {
  const btn = event.target.closest("[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  btn.disabled = true;
  try {
    if (action === "execute") {
      const res = await fetch(`${API}/missions/${id}/execute`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Execute failed");
    } else if (action === "status") {
      const res = await fetch(`${API}/missions/${id}/status`);
      const data = await res.json();
      alert(`Phase: ${data.phase || data.state}\nGate: ${JSON.stringify(data.gateResult || {})}`);
    }
    loadMissions();
    loadDashboard();
  } catch (err) {
    alert(err.message || "Mission action failed");
  } finally {
    btn.disabled = false;
  }
}

const btnConnect = document.getElementById("btn-connect-voice");
const btnMic = document.getElementById("btn-mic");
const indicator = document.getElementById("voice-indicator");
const statusText = document.getElementById("voice-status-text");
const transcriptEl = document.getElementById("transcript");
const textInput = document.getElementById("text-input");
const btnSendText = document.getElementById("btn-send-text");
const voicePlayer = document.getElementById("voice-player");

btnConnect.addEventListener("click", toggleVoiceConnection);
btnMic.addEventListener("click", toggleMic);
btnSendText.addEventListener("click", sendText);
textInput.addEventListener("keypress", (e) => { if (e.key === "Enter") sendText(); });
document.getElementById("btn-briefing").addEventListener("click", playBriefing);

async function playBriefing() {
  const btn = document.getElementById("btn-briefing");
  btn.disabled = true;
  btn.textContent = "Loading briefing…";
  try {
    const res = await fetch("/voice/briefing");
    if (!res.ok) throw new Error("Briefing failed");
    const buf = await res.arrayBuffer();
    await playAudio(buf);
    addTranscript("alfred", "Played operational briefing.");
  } catch (err) {
    addTranscript("system", "Could not play briefing.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Play briefing";
  }
}

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
    btnMic.textContent = "Start speaking";
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
    btnMic.textContent = "Stop speaking";
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
  if (voicePlayer) {
    const blob = new Blob([buffer], { type: "audio/mpeg" });
    voicePlayer.src = URL.createObjectURL(blob);
    try {
      await voicePlayer.play();
      return;
    } catch {}
  }
  if (!audioContext) audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(buffer);
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  source.start();
}

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

document.getElementById("btn-refresh-cop").addEventListener("click", loadCopMap);

async function loadCopMap() {
  try {
    const overview = await jsonOrEmpty(`${API}/cop/overview`);
    const burn = asArray(await jsonOrEmpty(`${API}/cop/burn-rate`));
    const missions = asArray(await jsonOrEmpty(`${API}/cop/missions`));
    const agents = asArray(await jsonOrEmpty(`${API}/cop/agents`));
    const voice = asArray(await jsonOrEmpty(`${API}/cop/voice`));
    const gateway = asArray(await jsonOrEmpty(`${API}/cop/gateway`));
    const memory = await jsonOrEmpty(`${API}/cop/memory`);

    document.getElementById("cop-stats").innerHTML = `
      <div class="stat-card"><div class="stat-value">${overview.active_missions ?? 0}</div><div class="stat-label">Active Missions</div></div>
      <div class="stat-card"><div class="stat-value">$${(overview.cost_today_usd ?? 0).toFixed(2)}</div><div class="stat-label">Cost Today</div></div>
      <div class="stat-card"><div class="stat-value">${overview.active_voice_sessions ?? 0}</div><div class="stat-label">Voice Sessions</div></div>
      <div class="stat-card"><div class="stat-value">${burn.reduce((s, b) => s + (b.burn_per_min || 0), 0).toFixed(0)}</div><div class="stat-label">Tokens/min</div></div>
    `;

    document.getElementById("cop-burn-rate").innerHTML = burn.length
      ? burn.map(b => copCell(b.agent, `${b.tokens} tokens · ${b.burn_per_min?.toFixed(1)} tokens/min`, b.burn_per_min > 0 ? "live" : "idle")).join("")
      : '<div class="empty-state">No burn data in last hour</div>';

    document.getElementById("cop-missions").innerHTML = missions.length
      ? missions.map(m => copCell(m.mission_id, `$${(m.total_cost_usd ?? 0).toFixed(4)} · ${(m.total_tokens_in || 0) + (m.total_tokens_out || 0)} tokens · ${m.ai_calls} AI calls`, m.ai_calls > 0 ? "ok" : "idle")).join("")
      : '<div class="empty-state">No mission cost data</div>';

    document.getElementById("cop-agents").innerHTML = agents.length
      ? agents.map(a => copCell(a.agent, `${a.calls} calls · $${(a.cost_usd ?? 0).toFixed(4)}`, a.calls > 0 ? "ok" : "idle")).join("")
      : '<div class="empty-state">No agent activity in last 24h</div>';

    document.getElementById("cop-voice").innerHTML = voice.length
      ? voice.map(v => copCell(v.status, `${v.n} sessions · ${v.total_seconds}s total`, v.status === "active" ? "live" : "idle")).join("")
      : '<div class="empty-state">No voice sessions</div>';

    document.getElementById("cop-gateway").innerHTML = gateway.length
      ? gateway.map(g => copCell(`${g.provider} / ${g.model}`, `${g.calls} calls · $${(g.cost_usd ?? 0).toFixed(4)}`, g.calls > 0 ? "warn" : "idle")).join("")
      : '<div class="empty-state">No gateway usage in last 24h</div>';

    document.getElementById("cop-memory").innerHTML = `
      ${copCell("KV (alfred-command)", `${memory.kv_keys} keys`, "ok")}
      ${copCell("D1 (alfred-db)", `${memory.d1_rows} rows`, "ok")}
      ${copCell("Agent Memory (alfred)", "Managed memory", "idle")}
    `;
  } catch (err) {
    console.error("COP Map error:", err);
  }
}

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
  const statusEl = document.getElementById("settings-status");

  try {
    const res = await fetch(`${API}/oral/preferences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: currentUserId, ...prefs }),
    });
    statusEl.textContent = res.ok ? "Settings saved." : "Save failed.";
    statusEl.className = res.ok ? "muted" : "upload-status error";
  } catch (err) {
    statusEl.textContent = "Failed to save settings";
    statusEl.className = "upload-status error";
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function jsonOrEmpty(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

(async function init() {
  const ok = await ensureAccess();
  if (!ok) return;
  checkHealth();
  loadDashboard();
  setInterval(checkHealth, 30000);
})();
