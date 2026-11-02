"""Background swap for the face-on-camera takes: RobustVideoMatting (mobilenetv3) cuts me out and puts me in front of
the warm dark room + lamp background. Runs as one shard of a parallel GitHub matrix.
Usage: python -I matte.py <edit.json> <recording.mp4> <background.jpg> <out_dir> [shard=0] [shards=1]
Alpha is computed at 960x540 and scaled up (4x faster on CPU), the composite is 1920x1080 30 fps, video only
(the cleaned voice is laid in by assemble.js). Output: take_<seg>_<piece>.mp4 (written .tmp then renamed).
"""
import json, os, subprocess, sys
import numpy as np
import torch
import torch.nn.functional as F

edit, rec, bgp, out = sys.argv[1:5]
shard = int(sys.argv[5]) if len(sys.argv) > 5 else 0
shards = int(sys.argv[6]) if len(sys.argv) > 6 else 1
os.makedirs(out, exist_ok=True)
torch.set_num_threads(os.cpu_count() or 4)
W, H, w, h = 1920, 1080, 960, 540

model = torch.hub.load("PeterL1n/RobustVideoMatting", "mobilenetv3", trust_repo=True).eval()

# background: scaled to fill, slightly soft (depth of field), as float tensor 1x3xHxW
bg = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", bgp, "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},gblur=sigma=3",
                     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
bg = torch.from_numpy(np.frombuffer(bg, np.uint8).reshape(H, W, 3).copy()).permute(2, 0, 1)[None].float() / 255
# my lighting toward the room's warm lamp light: a touch warmer and darker
tint = torch.tensor([1.03, 0.99, 0.92]).view(1, 3, 1, 1) * 0.94

takes = [t for t in json.load(open(edit, encoding="utf-8"))["takes"] if t.get("ok") and t.get("faceOk")]
jobs = [(t["seg"], i, p) for t in takes for i, p in enumerate(t["pieces"])]
jobs = [j for k, j in enumerate(jobs) if k % shards == shard]
print(f"shard {shard}/{shards}: {len(jobs)} pieces", flush=True)

for seg, i, (a, b) in jobs:
    dst = os.path.join(out, f"take_{seg:03d}_{i}.mp4")
    if os.path.exists(dst): continue
    src = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", rec,
                            "-vf", f"fps=30,scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}",
                            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", "30",
                            "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-f", "mp4", dst + ".tmp"],
                           stdin=subprocess.PIPE)
    rec_state = [None] * 4
    need, done, last = round((b - a) * 30), 0, None      # exactly this many frames (matches the voice piece)
    with torch.no_grad():
        while done < need:
            buf = src.stdout.read(W * H * 3)
            if len(buf) < W * H * 3:
                if last is None: break
                enc.stdin.write(last); done += 1; continue   # source ran short: hold the last frame
            done += 1
            full = torch.from_numpy(np.frombuffer(buf, np.uint8).reshape(H, W, 3).copy()).permute(2, 0, 1)[None].float() / 255
            small = F.interpolate(full, size=(h, w), mode="area")
            _, pha, *rec_state = model(small, *rec_state, downsample_ratio=0.4)
            pha = F.interpolate(pha, size=(H, W), mode="bilinear", align_corners=False).clamp(0, 1)
            comp = (full * tint).clamp(0, 1) * pha + bg * (1 - pha)
            last = (comp[0].permute(1, 2, 0) * 255).round().byte().numpy().tobytes()
            enc.stdin.write(last)
    src.kill(); src.wait(); enc.stdin.close(); enc.wait()
    if enc.returncode == 0:
        os.replace(dst + ".tmp", dst)
        print("done", os.path.basename(dst), f"{b - a:.1f}s", flush=True)
    else:
        print("FAILED", dst, flush=True)
