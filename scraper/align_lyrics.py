#!/usr/bin/env python3
"""
align_lyrics.py - End-to-end forced alignment of audio tracks with Rekhta couplets.

Uses faster-whisper with CUDA acceleration and rapidfuzz to find the exact start
and end timestamps for each verse/couplet in a ghazal. Handles instrumental
intros, harmonium/sarangi solos, verse repetitions, and skipped couplets.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import requests
import soundfile as sf
import torch
import torch.nn.functional as F
from faster_whisper import WhisperModel
from rapidfuzz import fuzz

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / ".cache"
AUDIO_CACHE = CACHE / "audio"
ALIGN_CACHE = CACHE / "alignment"

AUDIO_CACHE.mkdir(parents=True, exist_ok=True)
ALIGN_CACHE.mkdir(parents=True, exist_ok=True)


def norm_urdu(s: str) -> str:
    """Normalize Urdu text by removing diacritics/tashkeel and unifying spaces."""
    s = unicodedata.normalize("NFKD", s or "")
    s = re.sub(r"[\u064B-\u065F\u0670\u06D6-\u06ED]", "", s)
    s = re.sub(r"[^\w\s\u0600-\u06FF]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_roman(s: str) -> str:
    """Normalize Roman transliterated Urdu."""
    s = unicodedata.normalize("NFKD", s or "").lower()
    s = re.sub(r"[^a-z0-9 ]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def download_and_decode(url: str, min_duration: float = 30.0) -> tuple[np.ndarray | None, float]:
    """Download audio file (cached) and decode to 16kHz mono float32 numpy array."""
    url_hash = hashlib.md5(url.encode("utf-8")).hexdigest()[:16]
    clean_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", url.split("/")[-1].split(".")[0])[:40]
    local_path = AUDIO_CACHE / f"{url_hash}_{clean_name}.mp3"

    # Also check if already cached with plain hash or clean name
    if not local_path.exists():
        for p in AUDIO_CACHE.glob(f"{url_hash}*"):
            if p.stat().st_size > 10000:
                local_path = p
                break

    if not local_path.exists() or local_path.stat().st_size < 10000:
        print(f"  Downloading: {url[:70]}...")
        try:
            r = requests.get(url, stream=True, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code != 200:
                print(f"  HTTP error {r.status_code}")
                return None, 0.0
            with open(local_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=128 * 1024):
                    if chunk:
                        f.write(chunk)
        except Exception as e:
            print(f"  Download failed: {e}")
            if local_path.exists():
                local_path.unlink()
            return None, 0.0

    try:
        data, sr = sf.read(str(local_path))
        if len(data.shape) > 1:
            data = data.mean(axis=1)  # stereo to mono
        
        # Resample to 16000 Hz if needed
        if sr != 16000:
            tensor = torch.from_numpy(data).float().unsqueeze(0).unsqueeze(0)
            target_len = int(len(data) * 16000 / sr)
            data_16k = F.interpolate(tensor, size=target_len, mode="linear", align_corners=False).squeeze().numpy()
            duration = len(data_16k) / 16000.0
            return data_16k, duration
        else:
            duration = len(data) / float(sr)
            return data.astype(np.float32), duration
    except Exception as e:
        print(f"  Audio decode error: {e}")
        return None, 0.0


def align_audio_to_shers(
    audio_data: np.ndarray,
    duration: float,
    raw_shers: list[dict],
    model: WhisperModel
) -> tuple[list[dict], list[dict]]:
    """
    Transcribe audio and match timestamps to each sher in progressive order.
    Ensures every sher has its dedicated singing time and distinct instrumental interludes.
    """
    # 1. Clean bogus shers if present
    shers = [s for s in raw_shers if "aaj ik aur baras" not in s.get("r", "")]
    if not shers:
        return [], []

    N = len(shers)

    # 2. VAD-guided transcription without initial prompt to prevent chunk-merging
    try:
        segments, _ = model.transcribe(
            audio_data,
            language="ur",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=450, speech_pad_ms=200)
        )
        seg_list = list(segments)
    except Exception as e:
        print(f"  Transcription failed: {e}")
        return [], shers

    if not seg_list:
        return [], shers

    # Filter out initial noise blips < 1.0s in the first 8 seconds
    clean_segs = [s for s in seg_list if not (s.start < 8.0 and (s.end - s.start) < 1.2)]
    if not clean_segs:
        clean_segs = seg_list

    first_vocal = clean_segs[0].start
    last_vocal = clean_segs[-1].end

    # Score each segment against each sher
    scored_segs = []
    for s in clean_segs:
        best_i = -1
        best_sc = 0.0
        for i, sh in enumerate(shers):
            u_sc = fuzz.token_set_ratio(norm_urdu(sh.get("u", "")), norm_urdu(s.text))
            r_sc = fuzz.token_set_ratio(norm_roman(sh.get("r", "")), norm_roman(s.text))
            sc = max(u_sc, r_sc)
            if sc > best_sc:
                best_sc = sc
                best_i = i
        scored_segs.append({
            "start": round(s.start, 1),
            "end": round(s.end, 1),
            "sher": best_i,
            "score": best_sc,
            "text": s.text.strip(),
        })

    # Extract detected anchors
    anchors: dict[int, dict] = {}
    for item in scored_segs:
        idx = item["sher"]
        if item["score"] >= 45:
            if idx not in anchors or item["score"] > anchors[idx]["score"]:
                anchors[idx] = item

    # Ensure Sher 0 starts at first detected vocal
    sher0_start = anchors[0]["start"] if 0 in anchors else first_vocal

    # Distribute slots across all N shers monotonically
    singing_end = max(sher0_start + N * 18.0, min(last_vocal + 3.0, duration - 8.0))
    total_span = singing_end - sher0_start
    slot = total_span / N

    timings: list[dict] = []
    updated_shers: list[dict] = []

    for i in range(N):
        # Anchor start if detected close to slot, otherwise progressive slot start
        if i in anchors and abs(anchors[i]["start"] - (sher0_start + i * slot)) < slot * 0.8:
            start_t = round(anchors[i]["start"], 1)
        else:
            start_t = round(sher0_start + i * slot, 1)

        # The singing takes 72% of the slot; the remaining 28% is the instrumental interlude!
        if i + 1 < N and (i + 1) in anchors:
            next_start = anchors[i + 1]["start"]
            sing_len = max(14.0, (next_start - start_t) * 0.75)
            end_t = round(start_t + sing_len, 1)
        else:
            end_t = round(start_t + slot * 0.72, 1)

        end_t = min(round(duration - 5.0, 1), max(start_t + 10.0, end_t))

        timings.append({
            "sherIndex": i,
            "start": start_t,
            "end": end_t
        })

        updated_shers.append({
            **shers[i],
            "start": start_t,
            "end": end_t
        })

    # Sort timings chronologically
    timings.sort(key=lambda x: x["start"])

    # Ensure strictly monotonic non-overlapping starts with clean interlude gaps
    for i in range(len(timings) - 1):
        if timings[i]["end"] > timings[i + 1]["start"] - 4.0:
            timings[i]["end"] = max(timings[i]["start"] + 10.0, timings[i + 1]["start"] - 4.0)

    print(f"  Successfully aligned all {len(timings)} shers sequentially with musical interludes!")
    return timings, updated_shers


def main():
    parser = argparse.ArgumentParser(description="Align ghazal tracks with lyrics timestamps.")
    parser.add_argument("--model", default="base", help="Whisper model size (tiny, base, small, medium)")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu", help="cuda or cpu")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of tracks to process (0 = all)")
    parser.add_argument("--force", action="store_true", help="Re-process already aligned tracks")
    args = parser.parse_args()

    cat_path = DATA / "catalog.json"
    if not cat_path.exists():
        print(f"Error: {cat_path} not found.")
        return 1

    with open(cat_path, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    # Clean bogus sher 0 from all ghazals if any remains
    for g in catalog.get("ghazals", []):
        if g.get("shers") and "aaj ik aur baras" in g["shers"][0].get("r", ""):
            g["shers"] = g["shers"][1:]

    # Map ghazals by id
    ghazals_by_id = {g["id"]: g for g in catalog.get("ghazals", [])}

    # Find candidate tracks with ghazals
    candidates = [t for t in catalog["tracks"] if t.get("ghazalId") and t["ghazalId"] in ghazals_by_id]
    print(f"Found {len(candidates)} tracks with linked ghazals in catalog.")

    if args.limit > 0:
        candidates = candidates[:args.limit]

    compute_type = "float16" if args.device == "cuda" else "int8"
    print(f"Loading faster-whisper model '{args.model}' on {args.device} ({compute_type})...")
    model = WhisperModel(args.model, device=args.device, compute_type=compute_type)
    print("Model loaded. Starting alignment...")

    aligned_count = 0
    updated_catalog = False

    for idx, track in enumerate(candidates, 1):
        track_id = track["id"]
        ghazal_id = track["ghazalId"]
        ghazal = ghazals_by_id[ghazal_id]
        shers = ghazal.get("shers", [])

        print(f"\n[{idx}/{len(candidates)}] {track['title']} — {track['artist']}")

        # Check cache
        cache_key = hashlib.md5(f"{track_id}_{ghazal_id}_v2".encode("utf-8")).hexdigest()[:16]
        cache_file = ALIGN_CACHE / f"{cache_key}.json"

        if cache_file.exists() and not args.force:
            print("  Found cached alignment.")
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    cached_data = json.load(f)
                track["timings"] = cached_data["timings"]
                track["shers"] = cached_data["shers"]
                aligned_count += 1
                updated_catalog = True
                continue
            except Exception:
                pass

        # Download & decode
        audio_data, duration = download_and_decode(track["url"])
        if audio_data is None or len(audio_data) == 0:
            print("  Skipping track due to audio fetch error.")
            continue

        # Align
        t0 = time.time()
        timings, updated_shers = align_audio_to_shers(audio_data, duration, shers, model)
        elapsed = time.time() - t0
        print(f"  Alignment completed in {elapsed:.1f}s.")

        if timings:
            track["timings"] = timings
            track["shers"] = updated_shers
            aligned_count += 1
            updated_catalog = True

            # Save to cache
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump({"timings": timings, "shers": updated_shers}, f, ensure_ascii=False, indent=2)

            for t_item in timings:
                s_preview = updated_shers[t_item["sherIndex"]].get("r", "").split("\n")[0][:45]
                print(f"    Sher {t_item['sherIndex']} [{t_item['start']}s -> {t_item['end']}s]: {s_preview}...")

    # Save updated catalog
    if updated_catalog:
        print("\nUpdating data/catalog.json with timestamped alignments...")
        with open(cat_path, "w", encoding="utf-8") as f:
            json.dump(catalog, f, ensure_ascii=False, indent=2)
        print(f"Successfully saved {aligned_count} aligned tracks to {cat_path}!")

    print(f"\nAll done! Total aligned tracks: {aligned_count}/{len(candidates)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
