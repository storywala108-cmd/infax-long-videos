"""Recording cleaner: my camera recording + the script -> edit.json (which take of each paragraph to use, and whether
my face may be shown there).
Usage: python -I process.py <script.json> <recording.mp4> <out_dir>

1. Hindi transcript: faster-whisper small, int8, VAD on, beam 1, language hi (my standing settings), word times.
2. Each script paragraph (segment) is matched to the transcript (RapidFuzz on normalised Devanagari). When I made a
   mistake and read the paragraph again, the LAST good take is kept (a take only counts if the next paragraph
   follows it). Paragraphs I never read well (score < MIN_SCORE) are dropped.
3. Inside a take, pauses longer than 0.7 s are tightened to 0.3 s.
4. Face check (MediaPipe Face Landmarker, 4 fps): face present, head turned < 25 deg, eyes not closed for > 0.4 s,
   not looking away/down for > 1 s. A take whose face is good < 85 % of the time is used as voice only (visuals cover it).
"""
import json, math, os, re, subprocess, sys, urllib.request
import numpy as np
from rapidfuzz import fuzz

script_path, rec, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
S = json.load(open(script_path, encoding="utf-8"))
MIN_SCORE = 68

def norm(t):
    t = t.replace("़", "")                        # nukta
    t = re.sub("[ँं]", "ं", t)          # chandrabindu ~ anusvara
    t = re.sub(r"[^ऀ-ॿa-zA-Z0-9 ]", " ", t)
    # consonant skeleton: whisper-small's Hindi misspells matras/halant (वीरियो, सिकेंगे), consonants are stable
    t = re.sub("[ा-्ऀ-ःॢॣ]", "", t)
    return re.sub(r"\s+", " ", t).strip().lower()

# ---------- 1. transcript ----------
wav = os.path.join(out, "audio16k.wav")
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", rec, "-vn", "-ac", "1", "-ar", "16000", wav], check=True)
tjson = os.path.join(out, "words.json")
if os.path.exists(tjson):
    words = json.load(open(tjson, encoding="utf-8"))
else:
    from faster_whisper import BatchedInferencePipeline, WhisperModel
    # small garbled whole Hindi paragraphs in the test (2026-11-02), large-v3(-turbo) read them right → WHISPER_MODEL
    # (my rule: better models where the edit cuts my voice). The plain transcribe() dropped ~1/3 of the words after
    # a long pause; the batched pipeline transcribes every VAD speech chunk on its own, so nothing is skipped.
    m = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3-turbo"), device="cpu", compute_type="int8",
                     cpu_threads=os.cpu_count() or 4, num_workers=2)
    segs, _ = BatchedInferencePipeline(model=m).transcribe(wav, language="hi", beam_size=1, word_timestamps=True,
                                                           batch_size=4, chunk_length=15)
    words = [{"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)}
             for sg in segs for w in (sg.words or []) if w.word.strip()]
    json.dump(words, open(tjson, "w", encoding="utf-8"), ensure_ascii=False)
print("words:", len(words), flush=True)
nw = [norm(w["w"]) for w in words]

# ---------- 2. paragraph matching ----------
def candidates(text, lo, hi):
    """Non-overlapping spans in words[lo:hi] that read this paragraph, as (score, start, end) in order."""
    target = norm(text)
    L = max(1, len(target.split()))
    found = []
    for i in range(lo, min(hi, len(words))):
        if not nw[i] or fuzz.partial_ratio(nw[i], target) < 70:
            continue                                      # a take must start with a word of this paragraph
        best = (0, 0)
        for n in range(max(1, int(L * 0.6)), int(L * 1.35) + 2):
            if i + n > len(words): break
            sc = fuzz.ratio(" ".join(nw[i:i + n]), target)
            if sc > best[0]: best = (sc, n)
        if best[0] >= MIN_SCORE - 15:
            found.append((best[0], i, i + best[1]))
    out_, last_end = [], -1                               # keep the best of overlapping spans
    for c in sorted(found, key=lambda c: -c[0]):
        if all(c[2] <= o[1] or c[1] >= o[2] for o in out_): out_.append(c)
    return sorted(out_, key=lambda c: c[1])

def make_take(g, a, b, sc, retakes, gapfill=False):
    ws = words[a:b]
    pieces, cur = [], [ws[0]["s"] - 0.12, ws[0]["e"]]
    for w0, w1 in zip(ws, ws[1:]):                        # tighten pauses > 0.7 s to 0.3 s
        if w1["s"] - w0["e"] > 0.7:
            cur[1] = w0["e"] + 0.15; pieces.append(cur); cur = [w1["s"] - 0.15, w1["e"]]
        else:
            cur[1] = w1["e"]
    cur[1] += 0.2; pieces.append(cur)
    # whole frames at 30 fps, so voice pieces and video clips stay the same length (lesson 2026-10-24)
    pieces = [[round(max(0, x) * 30) / 30, round(y * 30) / 30] for x, y in pieces]
    pieces = [p for p in pieces if p[1] - p[0] >= 0.2]
    t = {"seg": g, "ok": True, "score": round(sc), "start": round(pieces[0][0], 2), "end": round(pieces[-1][1], 2),
         "pieces": [[round(x, 2), round(y, 2)] for x, y in pieces], "a_idx": a, "b_idx": b, "b": ws[-1]["e"],
         "prob": round(float(np.mean([w["p"] for w in ws])), 3), "retakes": retakes}
    if gapfill: t["gapfill"] = True
    return t

segs = S["segments"]
ptr, takes = 0, []
for g, seg in enumerate(segs):
    L = len(seg["text"].split())
    hi = ptr + 3 * L + 300
    cs = [c for c in candidates(seg["text"], ptr, hi) if c[0] >= MIN_SCORE]
    if not cs:
        takes.append({"seg": g, "ok": False, "why": "not read clearly"}); continue
    nxt = candidates(segs[g + 1]["text"], ptr, hi + 3 * L) if g + 1 < len(segs) else []
    nxt = [c for c in nxt if c[0] >= MIN_SCORE - 5]
    # last take of this paragraph that the next paragraph follows (retakes come later than the failed take)
    good = [c for c in cs if not nxt or any(n[1] >= c[2] - 1 for n in nxt)]
    best = max(c[0] for c in good or cs)
    pick = [c for c in (good or cs) if c[0] >= best - 6][-1]
    sc, a, b = pick
    # a span can swallow a false start ("राष्ट्रपति मौमून… [stop] राष्ट्रपति मौमून अब्दुल…"): move the start to the
    # LATEST word from which the paragraph still matches as well (within 2 points)
    target = norm(seg["text"])
    for a2 in range(a + 1, max(a + 1, b - int(L * 0.6))):
        if fuzz.ratio(" ".join(nw[a2:b]), target) >= sc - 2:
            a = a2
    takes.append(make_take(g, a, b, sc, len(cs) - 1))
    ptr = b

# Whisper often writes a repeated phrase only once, so a false start can hide inside a take. I'm told to pause
# ~2 s before reading a paragraph again: when a take has a silence >= 1.5 s inside it, the part after the silence
# is transcribed again on its own; if that part alone reads the whole paragraph, the take starts there.
sil = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", wav, "-af", "silencedetect=noise=-35dB:d=1.5", "-f", "null", "-"],
                     capture_output=True, text=True).stderr
silences = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", sil)]
_wm = None
def subtext(a, b):
    global _wm
    if _wm is None:
        from faster_whisper import WhisperModel
        _wm = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3-turbo"), device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    clip = os.path.join(out, "sub.wav")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{a:.2f}", "-to", f"{b:.2f}", "-i", wav, clip], check=True)
    sg, _ = _wm.transcribe(clip, language="hi", beam_size=1, word_timestamps=True, condition_on_previous_text=False)
    return [{"w": w.word.strip(), "s": round(a + w.start, 3), "e": round(a + w.end, 3), "p": round(w.probability, 3)}
            for s_ in sg for w in (s_.words or []) if w.word.strip()]
for k, t in enumerate(takes):
    if not t["ok"]: continue
    inner = [s for s in silences if t["start"] + 1.0 < s < t["end"] - 2.0]
    if not inner: continue
    ws2 = subtext(inner[-1] - 0.2, t["end"])
    if ws2 and fuzz.ratio(norm(" ".join(w["w"] for w in ws2)), norm(segs[t["seg"]]["text"])) >= t["score"] - 6:
        words.extend(ws2); nw.extend(norm(w["w"]) for w in ws2)            # make_take reads from words[]
        nt = make_take(t["seg"], len(words) - len(ws2), len(words), t["score"], t["retakes"] + 1)
        nt["a_idx"], nt["b_idx"] = t["a_idx"], t["b_idx"]                   # keep the main-transcript indices
        takes[k] = nt
        print(f"paragraph {t['seg'] + 1}: false start removed ({inner[-1] - t['start']:.1f} s)", flush=True)

# a paragraph the matcher missed, sitting between two found ones, is the gap between them when the gap's
# length fits the paragraph (~2.5 words/s); a gap far longer may hold a failed take → left out
for k, t in enumerate(takes):
    if t["ok"] or k == 0 or k + 1 >= len(takes) or not (takes[k - 1]["ok"] and takes[k + 1]["ok"]): continue
    a, b = takes[k - 1]["b_idx"], takes[k + 1]["a_idx"]
    if b <= a: continue
    gap, expect = words[b - 1]["e"] - words[a]["s"], len(segs[k]["text"].split()) / 2.5
    if 0.5 * expect <= gap <= 1.5 * expect:
        sc = fuzz.ratio(" ".join(nw[a:b]), norm(segs[k]["text"]))
        takes[k] = make_take(k, a, b, sc, 0, gapfill=True)
print("paragraphs used:", sum(t["ok"] for t in takes), "/", len(segs), flush=True)

# ---------- 3. face check ----------
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision
model = os.path.join(out, "face_landmarker.task")
if not os.path.exists(model):
    urllib.request.urlretrieve("https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task", model)
lm = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=model), running_mode=vision.RunningMode.IMAGE,
    output_face_blendshapes=True, output_facial_transformation_matrixes=True, num_faces=1))
FPS, W, H = 4, 640, 360
proc = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-i", rec, "-vf", f"fps={FPS},scale={W}:{H}", "-f", "rawvideo",
                         "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
frames, k = [], 0
while True:
    buf = proc.stdout.read(W * H * 3)
    if len(buf) < W * H * 3: break
    r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.frombuffer(buf, np.uint8).reshape(H, W, 3)))
    f = {"t": k / FPS, "face": bool(r.face_landmarks)}
    if f["face"]:
        R = np.array(r.facial_transformation_matrixes[0])[:3, :3]
        f["yaw"] = abs(math.degrees(math.asin(max(-1, min(1, -R[2, 0])))))
        f["pitch"] = abs(math.degrees(math.atan2(R[2, 1], R[2, 2])))
        b = {c.category_name: c.score for c in r.face_blendshapes[0]}
        f["closed"] = min(b["eyeBlinkLeft"], b["eyeBlinkRight"]) > 0.55
        f["away"] = max(b["eyeLookOutLeft"], b["eyeLookOutRight"], b["eyeLookDownLeft"], b["eyeLookDownRight"]) > 0.65
    frames.append(f); k += 1
proc.wait()
print("face frames:", len(frames), flush=True)

def bad_flags(fs):
    """Per frame: True = bad. Short blinks (<0.4 s) and glances (<1 s) are fine."""
    bad = [not f["face"] or f.get("yaw", 0) > 25 or f.get("pitch", 0) > 25 for f in fs]
    for key, limit in (("closed", 2), ("away", 4)):     # frames at 4 fps
        run = 0
        for i, f in enumerate(fs):
            run = run + 1 if f.get(key) else 0
            if run > limit:
                for j in range(i - run + 1, i + 1): bad[j] = True
    return bad

for t in takes:
    if not t["ok"]: continue
    fs = [f for f in frames if t["start"] <= f["t"] <= t["end"]]
    good = 1 - (sum(bad_flags(fs)) / len(fs)) if fs else 0
    t["faceGood"] = round(good, 2)
    t["faceOk"] = good >= 0.85
json.dump({"id": S["id"], "takes": takes}, open(os.path.join(out, "edit.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
ok = [t for t in takes if t["ok"]]
print("face shown possible:", sum(t["faceOk"] for t in ok), "/", len(ok),
      "| voice minutes:", round(sum(p[1] - p[0] for t in ok for p in t["pieces"]) / 60, 1))
