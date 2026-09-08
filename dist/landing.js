const wake = document.getElementById("wake");
const hint = document.getElementById("hint");
const player = document.getElementById("player");
const listen = document.getElementById("listen");

async function report() {
  wake.classList.add("playing");
  hint.textContent = "…";
  player.src = "/voice/hello";
  try {
    await player.play();
  } catch {
    hint.textContent = "Allow audio, then click again.";
  }
}

player.addEventListener("ended", () => {
  wake.classList.remove("playing");
  hint.textContent = "Click. Say it.";
});

wake.addEventListener("click", report);

function transcriptIsWake(text) {
  const t = text.toLowerCase().replace(/[!.?,]/g, " ");
  return t.includes("alfred") && t.includes("report");
}

listen.addEventListener("click", () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    hint.textContent = "This browser will not listen. Click the words instead.";
    report();
    return;
  }
  const rec = new SR();
  rec.lang = "en-GB";
  rec.interimResults = false;
  rec.onstart = () => { hint.textContent = "Listening. Say Alfred, report."; };
  rec.onerror = () => { hint.textContent = "Could not hear you. Click the words."; };
  rec.onresult = (event) => {
    const said = event.results[0][0].transcript;
    if (transcriptIsWake(said)) report();
    else hint.textContent = "Heard “" + said + "”. The wake word is Alfred, report.";
  };
  rec.start();
});
