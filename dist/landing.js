const wake = document.getElementById("wake");
const hint = document.getElementById("hint");
const player = document.getElementById("player");
const listen = document.getElementById("listen");
const SAY = 'Speak it<span class="bang">!</span>';

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

function loadHello() {
  if (helloLoad) return helloLoad;
  helloLoad = fetch("/voice/hello?v=5")
    .then((r) => r.arrayBuffer())
    .then((raw) => (audioCtx ? audioCtx.decodeAudioData(raw.slice(0)) : null))
    .then((buf) => { helloBuf = buf; })
    .catch(() => { helloLoad = null; });
  return helloLoad;
}

async function playHello() {
  wake.classList.add("playing");
  hint.innerHTML = "…";
  await keepAudio();
  if (!helloBuf) await loadHello();
  if (audioCtx && helloBuf && audioCtx.state === "running") {
    const src = audioCtx.createBufferSource();
    src.buffer = helloBuf;
    src.connect(audioCtx.destination);
    src.onended = () => {
      wake.classList.remove("playing");
      hint.innerHTML = SAY;
    };
    src.start();
    return;
  }
  player.src = "/voice/hello?v=5";
  try {
    await player.play();
  } catch {
    wake.classList.remove("playing");
    hint.innerHTML = SAY;
  }
}

player.addEventListener("ended", () => {
  wake.classList.remove("playing");
  hint.innerHTML = SAY;
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

function transcriptIsWake(text) {
  const t = text.toLowerCase().replace(/[!.?,]/g, " ");
  return t.includes("alfred") && t.includes("report");
}

async function armMic() {
  await keepAudio();
  loadHello();
  listen.classList.add("armed");
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
  rec.lang = "en-GB";
  rec.interimResults = false;
  rec.onstart = () => { hint.textContent = "Listening. Say it."; };
  rec.onerror = () => {
    hint.textContent = "Could not hear you. Tap again.";
    listen.classList.remove("armed");
  };
  rec.onend = () => { listen.classList.remove("armed"); };
  rec.onresult = (event) => {
    const said = event.results[0][0].transcript;
    if (transcriptIsWake(said)) playHello();
    else hint.textContent = "Heard “" + said + "”. Try again.";
  };
  rec.start();
}

listen.addEventListener("click", armMic);
