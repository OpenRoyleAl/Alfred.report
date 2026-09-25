#!/usr/bin/env python3
"""Bake static /public/audio/speak-it-demo.wav once. Never call TTS at runtime.

Alfred reports answers and mission status — he does not hand you chores.
British RP male via ElevenLabs (Daniel first). No Aussie-adjacent defaults.
Runtime keys: Cloudflare Secrets Store. Vault is bake-time only.
"""
import base64, json, os, subprocess, sys, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "audio" / "speak-it-demo.wav"
HELLO = ROOT / "public" / "audio" / "hello.wav"

# High-status mission report: answers + completion, not tasks / rent / payroll.
LINE = (
  "Two missions closed with proof. The third is running clean. "
  "Nothing needs a decision from you."
)

# Correct EL IDs (British male). Daniel = steady RP broadcaster — not George storytelling.
EL_VOICES = [
  ("Daniel", "onwK4e9ZLuTAKqWW03F9"),
  ("George", "JBFqnCBsd6RMkjVDRZzb"),
]


def vault_vals():
  env = Path.home() / ".vault" / "ai-providers.env"
  vals = {}
  if not env.is_file():
    return vals
  for line in env.read_text().splitlines():
    if not line or line.startswith("#") or "=" not in line:
      continue
    k, v = line.split("=", 1)
    vals[k.strip()] = v.strip().strip('"').strip("'")
  return vals


def loudnorm_write(raw_wav_path: Path):
  OUT.parent.mkdir(parents=True, exist_ok=True)
  # Keep pitch natural — no asetrate tricks that skew accent toward AU.
  filt = "loudnorm=I=-16:TP=-1.5:LRA=11,atempo=1.02"
  subprocess.check_call(
    [
      "ffmpeg", "-y", "-i", str(raw_wav_path),
      "-filter:a", filt,
      "-acodec", "pcm_s16le", "-ar", "24000", "-ac", "1", str(OUT),
    ],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
  )
  HELLO.write_bytes(OUT.read_bytes())


def bake_elevenlabs(key: str, voice_id: str, name: str) -> bool:
  # mp3 then decode — most reliable path
  url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
  body = json.dumps({
    "text": LINE,
    "model_id": "eleven_multilingual_v2",
    "voice_settings": {
      "stability": 0.72,
      "similarity_boost": 0.8,
      "style": 0.05,
      "use_speaker_boost": True,
    },
  }).encode()
  req = urllib.request.Request(
    url,
    data=body,
    headers={
      "xi-api-key": key,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    method="POST",
  )
  try:
    with urllib.request.urlopen(req, timeout=120) as r:
      raw = r.read()
  except urllib.error.HTTPError as e:
    print("EL", name, e.code, e.read()[:240])
    return False
  mp3 = Path("/tmp/alfred-bake-el.mp3")
  mp3.write_bytes(raw)
  wav = Path("/tmp/alfred-bake-raw.wav")
  subprocess.check_call(
    ["ffmpeg", "-y", "-i", str(mp3), "-acodec", "pcm_s16le", "-ar", "24000", "-ac", "1", str(wav)],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
  )
  loudnorm_write(wav)
  print("wrote", OUT, OUT.stat().st_size, "via EL", name, "id=", voice_id, "LINE=", LINE)
  return True


def bake_mimo(key: str, base: str) -> bool:
  style = (
    "You are Alfred Pennyworth of Wayne Manor: distinguished English butler, "
    "early sixties, Received Pronunciation — clearly British, never Australian. "
    "Deep chest voice. Dry. Precise. Status only: missions closed or still running. "
    "You give answers, not chores. No greeting. Never sir or ready."
  )
  body = json.dumps({
    "model": "mimo-v2.5-tts",
    "messages": [{"role": "user", "content": style}, {"role": "assistant", "content": LINE}],
    "audio": {"format": "wav", "voice": "Dean"},
  }).encode()
  req = urllib.request.Request(
    base.rstrip("/") + "/chat/completions",
    data=body,
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    method="POST",
  )
  with urllib.request.urlopen(req, timeout=120) as r:
    d = json.loads(r.read())
  raw = base64.b64decode(d["choices"][0]["message"]["audio"]["data"])
  tmp = Path("/tmp/alfred-bake-raw.wav")
  tmp.write_bytes(raw)
  loudnorm_write(tmp)
  print("wrote", OUT, OUT.stat().st_size, "via MiMo Dean LINE=", LINE)
  return True


def main():
  vals = vault_vals()
  el = os.environ.get("ELEVENLABS_API_KEY") or vals.get("ELEVENLABS_API_KEY")
  # Prefer Daniel only — George read as AU/TV to listeners.
  prefer = os.environ.get("ALFRED_EL_VOICE", "Daniel")
  order = [x for x in EL_VOICES if x[0] == prefer] + [x for x in EL_VOICES if x[0] != prefer]
  if el:
    for name, vid in order:
      if bake_elevenlabs(el, vid, name):
        return
  mimo = (
    os.environ.get("MIMO_PAYG_API_KEY")
    or os.environ.get("MIMO_API_KEY")
    or vals.get("MIMO_PAYG_API_KEY")
    or vals.get("MIMO_API_KEY")
  )
  base = os.environ.get("MIMO_PAYG_BASE_URL") or vals.get("MIMO_PAYG_BASE_URL") or "https://api.xiaomimimo.com/v1"
  if mimo and bake_mimo(mimo, base):
    return
  sys.exit("no ELEVENLABS_API_KEY or MIMO_PAYG_API_KEY for bake")


if __name__ == "__main__":
  main()
