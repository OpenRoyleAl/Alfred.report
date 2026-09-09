const wake = document.getElementById("wake");
const hint = document.getElementById("hint");
const player = document.getElementById("player");
const listen = document.getElementById("listen");
const SAY = 'Speak it<span class="bang">!</span>';

async function report() {
  wake.classList.add("playing");
  hint.innerHTML = "…";
  player.src = "/voice/hello";
  try {
    await player.play();
  } catch {
    hint.textContent = "Allow audio, then tap again.";
  }
}

player.addEventListener("ended", () => {
  wake.classList.remove("playing");
  hint.innerHTML = SAY;
});

wake.addEventListener("click", report);

function fitWake() {
  if (!wake) return;
  wake.style.fontSize = "80px";
  const textW = wake.scrollWidth;
  const maxW = document.documentElement.clientWidth - 24;
  if (!textW || maxW < 80) return;
  const size = 80 * (maxW / textW);
  wake.style.fontSize = Math.max(28, Math.min(size, 168)) + "px";
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
  listen.classList.add("armed");
  hint.textContent = "Allow the mic…";
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    }
  } catch {
    hint.textContent = "Mic blocked. Allow it, then tap again.";
    listen.classList.remove("armed");
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    hint.textContent = "This browser will not listen. Tap the words.";
    listen.classList.remove("armed");
    report();
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
    if (transcriptIsWake(said)) report();
    else hint.textContent = "Heard “" + said + "”. Try again.";
  };
  rec.start();
}

listen.addEventListener("click", armMic);
