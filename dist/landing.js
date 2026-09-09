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
