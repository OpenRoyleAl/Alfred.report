/* In-app voice for signed-in users. Say "Alfred.report!" (the instance wake word) for The Report;
 * owners: "start a mission ..." then "Go Max AI!". Browser speech recognition when available
 * (continuous, wake-word gated); otherwise tap-to-talk recording sent to /api/alfred/voice. */
(function () {
  if (window.__alfredVoice) return;
  window.__alfredVoice = true;
  var host = location.hostname.replace(/^www\./, "");
  var brand = (window.ALFRED_BRAND && window.ALFRED_BRAND.Name) || host.split(".")[0] || "alfred";
  var wakeRe = new RegExp("\\b" + brand + "\\W*(dot\\s*)?report\\b", "i");
  var pending = null, pendingId = null, listening = false, busy = false, rec = null;
  // One client requestId per drafted mission: a repeated "Go Max AI!" (or a network retry) is one run.
  function rid() { try { return "voice-" + crypto.randomUUID(); } catch (e) { return "voice-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } }
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var box = document.createElement("div");
  box.innerHTML = '<div class="orb-say glass" id="alv-say" role="status" aria-live="polite"></div>' +
    '<button type="button" class="orb" id="alv-btn" aria-pressed="false" aria-label="Voice. Say ' + brand + '.report! for The Report" title="Voice: say &quot;' + brand + '.report!&quot;">' +
    '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg></button>';
  document.body.appendChild(box);
  var say = box.querySelector("#alv-say"), btn = box.querySelector("#alv-btn");
  function setOn(v) { btn.classList.toggle("on", v); btn.setAttribute("aria-pressed", v ? "true" : "false"); }
  window.alfredVoiceToggle = function () { btn.click(); };
  function show(t) { say.textContent = t; say.classList.add("show"); }
  function speakOut(t) {
    try { speechSynthesis.cancel(); var u = new SpeechSynthesisUtterance(t); u.rate = 1.02; speechSynthesis.speak(u); } catch (e) {}
  }
  function send(body, ct) {
    busy = true; btn.classList.add("busy");
    var q = ct.indexOf("audio/") === 0 && pending ? "?pending=" + encodeURIComponent(pending) + "&requestId=" + encodeURIComponent(pendingId || "") : "";
    return fetch("/api/alfred/voice" + q, { method: "POST", credentials: "same-origin", headers: { "Content-Type": ct }, body: body })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
      .then(function (j) { var next = j.pending || null; if (next !== pending) pendingId = next ? rid() : null; pending = next; show(j.text); speakOut(j.text); if (j.action === "start" && window.loadMissions) try { window.loadMissions(); } catch (e) {} })
      .catch(function (e) { show("Voice error: " + e.message); })
      .then(function () { busy = false; btn.classList.remove("busy"); });
  }
  function handle(text) {
    // Wake-word gated while listening hands-free; a pending draft also accepts "Go Max AI!"/"cancel".
    if (!wakeRe.test(text) && !(pending && /go\s*max|cancel/i.test(text))) return;
    show("Heard: " + text);
    send(JSON.stringify({ text: text, pending: pending, requestId: pendingId }), "application/json");
  }

  if (SR) {
    rec = new SR(); rec.continuous = true; rec.interimResults = false; rec.lang = "en-GB";
    rec.onresult = function (ev) {
      for (var i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal && !busy) handle(ev.results[i][0].transcript.trim());
    };
    rec.onend = function () { if (listening) try { rec.start(); } catch (e) {} };
    rec.onerror = function (e) { if (e.error === "not-allowed") { listening = false; setOn(false); show("Microphone blocked."); } };
    btn.onclick = function () {
      listening = !listening; setOn(listening);
      if (listening) { try { rec.start(); } catch (e) {} show('Listening. Say "' + brand + '.report!"'); } else { rec.stop(); show("Voice off."); }
    };
  } else if (navigator.mediaDevices && window.MediaRecorder) {
    var mr = null, chunks = [];
    btn.onclick = function () {
      if (mr && mr.state === "recording") { mr.stop(); return; }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        chunks = []; mr = new MediaRecorder(stream);
        mr.ondataavailable = function (e) { chunks.push(e.data); };
        mr.onstop = function () {
          setOn(false); stream.getTracks().forEach(function (t) { t.stop(); });
          var b = new Blob(chunks, { type: mr.mimeType || "audio/webm" }); send(b, (b.type || "audio/webm").split(";")[0]);
        };
        mr.start(); setOn(true); show("Recording. Tap again to send.");
      }).catch(function () { show("Microphone blocked."); });
    };
  } else {
    btn.onclick = function () { var t = prompt('Say it as text (e.g. "' + brand + '.report!")'); if (t) send(JSON.stringify({ text: t, pending: pending, requestId: pendingId }), "application/json"); };
  }
})();
