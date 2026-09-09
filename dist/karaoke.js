window.Karaoke = (function () {
  const BACK = 3;
  const FWD = 3;
  let raf = 0;

  function wordsOf(text) {
    return text.trim().split(/\s+/);
  }

  function indexAt(t, duration, words) {
    if (!duration) return 0;
    const weights = words.map((w) => Math.max(3, w.replace(/[^\w']/g, "").length));
    const total = weights.reduce((a, b) => a + b, 0);
    const pos = Math.min(1, Math.max(0, t / duration)) * total;
    let acc = 0;
    for (let i = 0; i < words.length; i++) {
      acc += weights[i];
      if (pos < acc) return i;
    }
    return words.length - 1;
  }

  function paint(host, words, center) {
    const from = Math.max(0, center - BACK);
    const to = Math.min(words.length - 1, center + FWD);
    const line = document.createElement("span");
    line.className = "k-line";
    for (let i = from; i <= to; i++) {
      const w = document.createElement("span");
      w.className = "k-word" + (i === center ? " now" : "");
      w.textContent = words[i];
      line.appendChild(w);
    }
    const ball = document.createElement("span");
    ball.className = "k-ball";
    host.replaceChildren(line, ball);
    const now = line.querySelector(".k-word.now");
    if (now) {
      ball.style.left = now.offsetLeft + now.offsetWidth / 2 + "px";
      ball.style.top = now.offsetTop + now.offsetHeight + 2 + "px";
    }
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function start(host, text, duration, when) {
    stop();
    const words = wordsOf(text);
    let last = -1;
    function tick() {
      const t = when();
      const i = indexAt(t, duration, words);
      if (i !== last) {
        last = i;
        paint(host, words, i);
      }
      if (t < duration) raf = requestAnimationFrame(tick);
    }
    paint(host, words, 0);
    raf = requestAnimationFrame(tick);
  }

  return { wordsOf, start, stop };
})();
