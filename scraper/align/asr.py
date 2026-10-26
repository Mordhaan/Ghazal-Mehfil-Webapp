"""ASR front end: word-level timestamps for one recording, cached on disk.

faster-whisper is the only heavy dependency in the pipeline and it is imported
lazily, so `--report`, `check` and the migration script run on a bare Python.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

from .text import AsrWord, is_devanagari, is_urdu, strip_marks

ROOT = Path(__file__).resolve().parent.parent.parent
DATA = ROOT / "data"
AUDIO = DATA / ".audio"
MODELS = DATA / ".models"
AUDIO.mkdir(parents=True, exist_ok=True)
MODELS.mkdir(parents=True, exist_ok=True)

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
_MODEL = None
_MODEL_KEY: tuple[str, str, str] | None = None


def cache_key(track: dict) -> str:
    """Stable per-media key: positional ids change when the catalogue rebuilds."""
    url = track.get("url") or ""
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
    stem = re.sub(r"[^A-Za-z0-9]+", "_", track.get("title") or "")[:44].strip("_")
    return f"{stem}_{digest}" if stem else digest


def ensure_audio(track: dict, timeout: int = 600) -> Path | None:
    safe = cache_key(track)
    for ext in (".mp3", ".wav", ".m4a", ".ogg", ".flac"):
        p = AUDIO / f"{safe}{ext}"
        if p.exists() and p.stat().st_size > 20_000:
            return p
    if not track.get("url"):
        return None

    dest = AUDIO / f"{safe}.mp3"
    tmp = dest.with_suffix(".part")
    req = urllib.request.Request(track["url"], headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as fh:
            shutil.copyfileobj(r, fh)
        if tmp.stat().st_size < 20_000:
            tmp.unlink(missing_ok=True)
            return None
        tmp.replace(dest)
        return dest
    except Exception as e:
        print(f"    ! download failed: {e}")
        tmp.unlink(missing_ok=True)
        return None


def available_devices() -> int:
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def pick_device(pref: str) -> tuple[str, str]:
    if pref == "cpu":
        return "cpu", "int8"
    n = available_devices()
    if pref == "cuda" or (pref == "auto" and n > 0):
        return "cuda", "float16"
    return "cpu", "int8"


def _patch_pyav() -> None:
    """faster-whisper 1.2 passes `metadata_errors=` to `av.open`, which PyAV 19
    removed. Drop the kwarg instead of pinning an old PyAV (no cp313 wheel)."""
    import av

    if getattr(av, "_gfz_patched", False):
        return
    original = av.open

    def open_compat(*args, **kwargs):
        kwargs.pop("metadata_errors", None)
        return original(*args, **kwargs)

    av.open = open_compat
    av._gfz_patched = True


def load_model(size: str, device: str, compute: str):
    global _MODEL, _MODEL_KEY
    key = (size, device, compute)
    if _MODEL is not None and _MODEL_KEY == key:
        return _MODEL
    _patch_pyav()
    from faster_whisper import WhisperModel

    # Prefer a plain local directory (used when HF's xet CDN stalls); fall back
    # to the named model and let faster-whisper manage its cache.
    local = DATA / "models" / f"faster-whisper-{size}"
    model_id = str(local) if (local / "model.bin").exists() else size

    _MODEL = WhisperModel(
        model_id,
        device=device,
        compute_type=compute,
        download_root=str(MODELS),
        cpu_threads=max(2, (os.cpu_count() or 4) - 1),
    )
    _MODEL_KEY = key
    return _MODEL


def detect_script(words: list[AsrWord]) -> str:
    ur = sum(1 for w in words if is_urdu(w.text))
    hi = sum(1 for w in words if is_devanagari(w.text))
    latin = sum(1 for w in words if re.search(r"[A-Za-z]", w.text))
    if ur >= hi and ur >= latin:
        return "urdu"
    if hi > ur:
        return "hindi"
    return "roman"


def transcribe(
    audio: Path,
    *,
    model_size: str = "small",
    device: str = "auto",
    compute: str | None = None,
    language: str = "ur",
    progress: bool = True,
) -> tuple[list[AsrWord], dict]:
    dev, comp = pick_device(device)
    if compute:
        comp = compute
    model = load_model(model_size, dev, comp)

    segments, info = model.transcribe(
        str(audio),
        language=language,
        beam_size=5,
        word_timestamps=True,
        # Silero VAD is trained on speech; it throws away sustained sung vowels.
        # On a ghazal that removed two thirds of the performance in testing.
        vad_filter=False,
        condition_on_previous_text=False,
        no_speech_threshold=0.85,
    )

    words: list[AsrWord] = []
    for seg in segments:
        for w in seg.words or []:
            text = strip_marks((w.word or "").strip())
            if not text:
                continue
            start = float(w.start)
            end = float(w.end)
            if end <= start:
                end = start + 0.06
            words.append(AsrWord(start, end, text, float(getattr(w, "probability", 1.0) or 1.0)))
        if progress:
            print(f"    … {seg.end:6.1f}s / {info.duration:6.1f}s", end="\r", flush=True)

    if progress:
        print(" " * 44, end="\r", flush=True)

    # drop hallucinated runs: same token repeated with no syllable variation
    cleaned: list[AsrWord] = []
    for w in words:
        if len(cleaned) >= 6 and len({x.text for x in cleaned[-6:]}) == 1 and w.text == cleaned[-1].text:
            continue
        cleaned.append(w)

    meta = {
        "language": info.language,
        "language_probability": round(float(info.language_probability), 3),
        "duration": round(float(info.duration), 2),
        "model": model_size,
        "device": dev,
        "compute_type": comp,
    }
    return cleaned, meta


def cache_words(audio: Path, words: list[AsrWord], meta: dict, model_size: str) -> Path:
    """Keep the raw ASR next to the audio so re-aligning never re-transcribes."""
    p = AUDIO / f"{audio.stem}.asr-{model_size}.json"
    p.write_text(
        json.dumps(
            {
                "meta": meta,
                "words": [{"s": round(w.start, 3), "e": round(w.end, 3), "t": w.text, "p": round(w.prob, 3)} for w in words],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return p


def load_cached_words(audio: Path, model_size: str) -> tuple[list[AsrWord], dict] | None:
    p = AUDIO / f"{audio.stem}.asr-{model_size}.json"
    if not p.exists():
        return None
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        words = [AsrWord(float(w["s"]), float(w["e"]), w["t"], float(w.get("p", 1.0))) for w in doc["words"]]
        return words, doc.get("meta", {})
    except Exception:
        return None
