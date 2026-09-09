const wake = document.getElementById("wake");
const hint = document.getElementById("hint");
const player = document.getElementById("player");
const listen = document.getElementById("listen");
const SAY = 'Speak it<span class="bang">!</span>';
const REPORT =
  "Board is live. One open mission: evidence pack. Still in bounds. Cost today, twelve cents. Token burn is light. Nothing failed. That is the report.";
const HELLO = "/voice/hello?v=6";

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let helloBuf = null;
let helloLoad = null;

function keepAudio() {
  if (!AudioCtx) return Promise.resolve();
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === "running") return Promise.resolve();
  return audioCtx.resume();
}

function peakNormalize(buf) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  if (peak < 0.0001 || peak >= 0.98) return buf;
  const mul = 0.98 / peak;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = Math.max(-1, Math.min(1, data[i] * mul));
  }
  return buf;
}

function loadHello() {
  if (helloLoad) return helloLoad;
  helloLoad = fetch(HELLO)
    .then((r) => r.arrayBuffer())
    .then((raw) => (audioCtx ? audioCtx.decodeAudioData(raw.slice(0)) : null))
    .then((buf) => { helloBuf = buf ? peakNormalize(buf) : null; })
    .catch(() => { helloLoad = null; });
  return helloLoad;
}

function showReport() {
  listen.classList.add("reporting");
}

function hideReport() {
  if (window.Karaoke) Karaoke.stop();
  listen.classList.remove("reporting", "armed");
  hint.innerHTML = SAY;
}

async function playHello() {
  wake.classList.add("playing");
  showReport();
  await keepAudio();
  if (!helloBuf) await loadHello();
  if (audioCtx && helloBuf && audioCtx.state === "running") {
    const src = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    gain.gain.value = 1;
    src.buffer = helloBuf;
    src.connect(gain);
    gain.connect(audioCtx.destination);
    const started = audioCtx.currentTime;
    src.onended = () => {
      wake.classList.remove("playing");
      hideReport();
    };
    src.start();
    Karaoke.start(hint, REPORT, helloBuf.duration, () => audioCtx.currentTime - started);
    return;
  }
  player.volume = 1;
  player.src = HELLO;
  try {
    await player.play();
    Karaoke.start(hint, REPORT, player.duration || 8, () => player.currentTime);
  } catch {
    wake.classList.remove("playing");
    hideReport();
  }
}

player.addEventListener("ended", () => {
  wake.classList.remove("playing");
  hideReport();
});

wake.addEventListener("click", () => {
  keepAudio();
  playHello();
});

function fitWake() {
  if (!wake) return;
  const hero = document.querySelector(".hero");
  let maxW = 0;
  if (hero) {
    const cs = getComputedStyle(hero);
    maxW = hero.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }
  if (window.visualViewport) maxW = Math.min(maxW || visualViewport.width, visualViewport.width - 32);
  if (!maxW) maxW = document.documentElement.clientWidth - 48;
  wake.style.fontSize = "64px";
  const textW = wake.scrollWidth;
  if (!textW || maxW < 72) return;
  const size = 64 * ((maxW - 8) / textW);
  wake.style.fontSize = Math.max(26, Math.min(size, 148)) + "px";
}

let fitTick;
function fitWakeSoon() {
  clearTimeout(fitTick);
  fitTick = setTimeout(fitWake, 50);
}

if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitWake);
window.addEventListener("resize", fitWakeSoon);
fitWake();

function editDist(a, b) {
  const m = [];
  for (let i = 0; i <= a.length; i++) {
    m[i] = [i];
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = i === 0
        ? j
        : Math.min(
            m[i - 1][j] + 1,
            m[i][j - 1] + 1,
            m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
          );
    }
  }
  return m[a.length][b.length];
}

function near(word, target, n) {
  if (word === target) return true;
  if (word.length < 4) return false;
  return editDist(word, target) <= n;
}

function transcriptIsWake(text) {
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const joined = tokens.join(" ");
  const hasAlfred =
    joined.includes("alfred") ||
    tokens.some((w) => near(w, "alfred", 2) || near(w, "alford", 1));
  const hasReport =
    joined.includes("report") ||
    tokens.some((w) => near(w, "report", 2) || w === "reports" || w === "reported");
  return hasAlfred && hasReport;
}

function speechLang() {
  const lang = (navigator.language || "").toLowerCase();
  if (lang.startsWith("en")) return navigator.language;
  if (lang.startsWith("fil") || lang.startsWith("tl") || lang.startsWith("ceb")) return "en-PH";
  return "en-GB";
}

async function armMic() {
  await keepAudio();
  loadHello();
  listen.classList.add("armed");
  listen.classList.remove("reporting");
  hint.textContent = "Listening. Say it.";
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    }
  } catch {
    hint.textContent = "Mic blocked. Tap again and allow it.";
    listen.classList.remove("armed");
    return;
  }
  await keepAudio();

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    listen.classList.remove("armed");
    playHello();
    return;
  }

  const rec = new SR();
  rec.lang = speechLang();
  rec.interimResults = false;
  rec.maxAlternatives = 5;
  rec.onstart = () => { hint.textContent = "Listening. Say it."; };
  rec.onerror = () => {
    hint.textContent = "Could not hear you. Tap again.";
    listen.classList.remove("armed");
  };
  rec.onend = () => { listen.classList.remove("armed"); };
  rec.onresult = (event) => {
    const alts = [];
    const row = event.results[0];
    for (let i = 0; i < row.length; i++) alts.push(row[i].transcript);
    if (alts.some(transcriptIsWake)) playHello();
    else hint.textContent = "Heard “" + alts[0] + "”. Try again.";
  };
  rec.start();
}

listen.addEventListener("click", armMic);
