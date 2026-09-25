const wake = document.getElementById("wake");
const hint = document.getElementById("hint");
const player = document.getElementById("player");
const listen = document.getElementById("listen");
/* Static demo WAV only — never call TTS on click. */
const SAY = "WAKE";
const LINE = "Two missions closed with proof. The third is running clean. Nothing needs a decision from you.";
const HELLO = "/audio/speak-it-demo.wav?v=12";

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let helloRaw = null;
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

function fetchHello() {
  if (helloLoad) return helloLoad;
  helloLoad = fetch(HELLO)
    .then((r) => {
      if (!r.ok) throw new Error("demo audio " + r.status);
      return r.arrayBuffer();
    })
    .then((raw) => {
      helloRaw = raw;
    })
    .catch(() => {
      helloLoad = null;
    });
  return helloLoad;
}

async function decodeHello() {
  if (helloBuf) return helloBuf;
  await fetchHello();
  if (!helloRaw || !audioCtx) return null;
  helloBuf = peakNormalize(await audioCtx.decodeAudioData(helloRaw.slice(0)));
  return helloBuf;
}

function showSpeaking() {
  listen.classList.add("reporting");
  if (hint) hint.textContent = LINE;
}

function hideSpeaking() {
  if (window.Karaoke) Karaoke.stop();
  listen.classList.remove("reporting");
  if (hint) hint.textContent = SAY;
}

async function playHello() {
  if (wake) wake.classList.add("playing");
  showSpeaking();
  await keepAudio();
  const buf = await decodeHello();
  if (audioCtx && buf && audioCtx.state === "running") {
    const src = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    gain.gain.value = 1;
    src.buffer = buf;
    src.connect(gain);
    gain.connect(audioCtx.destination);
    const started = audioCtx.currentTime;
    src.onended = () => {
      if (wake) wake.classList.remove("playing");
      hideSpeaking();
    };
    src.start();
    if (window.Karaoke) Karaoke.start(hint, LINE, buf.duration, () => audioCtx.currentTime - started);
    return;
  }
  player.volume = 1;
  player.src = HELLO;
  try {
    await player.play();
    if (window.Karaoke) Karaoke.start(hint, LINE, player.duration || 3, () => player.currentTime);
  } catch {
    if (wake) wake.classList.remove("playing");
    hideSpeaking();
  }
}

player.addEventListener("ended", () => {
  if (wake) wake.classList.remove("playing");
  hideSpeaking();
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
fetchHello();

if (listen) {
  listen.addEventListener("click", () => {
    keepAudio();
    playHello();
  });
}
