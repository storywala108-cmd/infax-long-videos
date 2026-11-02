"""Still graphics for the Infax documentary (1920x1080 PNG; motion is added later by FFmpeg).
Usage: python -I cards.py <jobs.json>   jobs = [{"type":"map|source|name", "out":"x.png", ...}]
  map:    lon, lat, label, [span=16]   dark map, glowing borders, highlighted country, red pin + label
  source: source, quote, [bg]         cream paper quote card with yellow highlight + red SOURCE strip
  name:   name, role, [bg]            big name + red role box over a darkened picture
On-screen text is English (my rule); fonts Poppins (OFL). Map data: Natural Earth 10m, India point of view (public domain).
"""
import json, math, os, sys, textwrap
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1920, 1080
F = lambda n, s: ImageFont.truetype(os.path.join(ROOT, "fonts", n), s)
RED, YEL = (214, 40, 40), (255, 214, 0)
_geo = None

def geo():
    global _geo
    if _geo is None:
        _geo = json.load(open(os.path.join(ROOT, "data", "ne_10m_ind.geojson"), encoding="utf-8"))["features"]
    return _geo

def backdrop(bg):
    if bg and os.path.exists(bg):
        im = Image.open(bg).convert("RGB")
        s = max(W / im.width, H / im.height)
        im = im.resize((int(im.width * s) + 1, int(im.height * s) + 1)).crop((0, 0, W, H))
        return Image.blend(im.filter(ImageFilter.GaussianBlur(14)), Image.new("RGB", (W, H), (8, 8, 10)), 0.55)
    im = Image.new("RGB", (W, H), (14, 16, 20))
    d = ImageDraw.Draw(im)
    for y in range(H): d.line([(0, y), (W, y)], fill=(14 + y // 40, 16 + y // 50, 22 + y // 36))
    return im

def inside(lon, lat, ring):
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1 + 1e-12) + x1: c = not c
    return c

def map_card(j):
    lon0, lat0, span = float(j["lon"]), float(j["lat"]), float(j.get("span", 16))
    merc = lambda lo, la: (math.radians(lo), math.log(math.tan(math.pi / 4 + math.radians(max(-80, min(80, la))) / 2)))
    cx, cy = merc(lon0, lat0)
    k = W / math.radians(span * 1.6)
    P = lambda lo, la: (W / 2 + (merc(lo, la)[0] - cx) * k, H / 2 - (merc(lo, la)[1] - cy) * k)
    im = Image.new("RGB", (W, H), (9, 20, 32)); glow = Image.new("RGB", (W, H), (0, 0, 0))
    d, dg = ImageDraw.Draw(im), ImageDraw.Draw(glow)
    for f in geo():
        g = f["geometry"]
        for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]):
            ring = poly[0]
            xs = [c[0] for c in ring]; ys = [c[1] for c in ring]
            if max(xs) < lon0 - span * 2 or min(xs) > lon0 + span * 2 or max(ys) < lat0 - span * 1.5 or min(ys) > lat0 + span * 1.5:
                continue
            pts = [P(x, y) for x, y in ring[:: max(1, len(ring) // 1500)]]
            hot = inside(lon0, lat0, ring)
            d.polygon(pts, fill=(28, 112, 120) if hot else (27, 41, 56))
            dg.line(pts + pts[:1], fill=(60, 220, 255) if hot else (40, 120, 160), width=6 if hot else 3)
    glow = glow.filter(ImageFilter.GaussianBlur(6))
    im = ImageChops.add(im, glow)
    d = ImageDraw.Draw(im)
    for f in geo():                                       # crisp borders on top of the glow
        g = f["geometry"]
        for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]):
            ring = poly[0]
            if max(c[0] for c in ring) < lon0 - span * 2 or min(c[0] for c in ring) > lon0 + span * 2: continue
            pts = [P(x, y) for x, y in ring[:: max(1, len(ring) // 1500)]]
            d.line(pts + pts[:1], fill=(150, 230, 255), width=1)
    x, y = W / 2, H / 2
    for r, a in ((46, 40), (30, 90)):
        ov = Image.new("RGBA", (W, H)); ImageDraw.Draw(ov).ellipse([x - r, y - r, x + r, y + r], fill=RED + (a,)); im.paste(ov, (0, 0), ov)
    d.ellipse([x - 14, y - 14, x + 14, y + 14], fill=RED, outline=(255, 255, 255), width=4)
    lab = j.get("label", "").upper()[:28]
    fnt = F("Poppins-Black.ttf", 54)
    tw = d.textlength(lab, font=fnt)
    bx, by = min(W - tw - 80, x + 40), y - 110
    d.rounded_rectangle([bx, by, bx + tw + 48, by + 84], 14, fill=(255, 255, 255))
    d.text((bx + 24, by + 6), lab, font=fnt, fill=(16, 16, 20))
    return im

def source_card(j):
    im = backdrop(j.get("bg"))
    fq = F("Poppins-Bold.ttf", 58)
    lines = textwrap.wrap(j.get("quote", ""), 34)[:7]
    paper = Image.new("RGB", (1240, 140 + 88 * len(lines)), (243, 236, 217))
    pd = ImageDraw.Draw(paper)
    fq = F("Poppins-Bold.ttf", 52)
    y = 70
    for ln in lines:
        tw = pd.textlength(ln, font=fq)
        pd.rectangle([60, y + 8, 60 + tw + 10, y + 60], fill=(255, 226, 92))
        pd.text((65, y), ln, font=fq, fill=(28, 24, 20)); y += 88
    sh = Image.new("RGBA", (paper.width + 60, paper.height + 60), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rectangle([30, 40, paper.width + 30, paper.height + 40], fill=(0, 0, 0, 150))
    sh = sh.filter(ImageFilter.GaussianBlur(18))
    px, py = (W - paper.width) // 2, (H - paper.height - 110) // 2
    im.paste(sh, (px - 30, py - 30), sh); im.paste(paper, (px, py))
    d = ImageDraw.Draw(im)
    src = "SOURCE: " + j.get("source", "").upper()[:60]
    fs = F("Poppins-ExtraBold.ttf", 38)
    tw = d.textlength(src, font=fs)
    d.rectangle([px, py + paper.height + 30, px + tw + 50, py + paper.height + 100], fill=RED)
    d.text((px + 25, py + paper.height + 38), src, font=fs, fill=(255, 255, 255))
    return im

def name_card(j):
    im = backdrop(j.get("bg"))
    ov = Image.new("RGBA", (W, H)); od = ImageDraw.Draw(ov)
    for x in range(W): od.line([(x, 0), (x, H)], fill=(0, 0, 0, int(200 * max(0, 1 - x / (W * 0.7)))))
    im.paste(ov, (0, 0), ov)
    d = ImageDraw.Draw(im)
    name = j.get("name", "").upper()
    size = 120
    while size > 60 and d.textlength(name, font=F("Poppins-Black.ttf", size)) > W * 0.62: size -= 6
    fn = F("Poppins-Black.ttf", size)
    y = H // 2 - size
    d.text((120 + 4, y + 4), name, font=fn, fill=(0, 0, 0))
    d.text((120, y), name, font=fn, fill=(255, 255, 255))
    role = j.get("role", "").upper()[:48]
    fr = F("Poppins-ExtraBold.ttf", 42)
    tw = d.textlength(role, font=fr)
    ry = y + size + 40
    d.rectangle([120, ry, 120 + tw + 50, ry + 70], fill=RED)
    d.text((145, ry + 6), role, font=fr, fill=(255, 255, 255))
    d.rectangle([120, y - 30, 300, y - 20], fill=YEL)
    return im

for j in json.load(open(sys.argv[1], encoding="utf-8")):
    if os.path.exists(j["out"]): continue
    im = {"map": map_card, "source": source_card, "name": name_card}[j["type"]](j)
    im.save(j["out"] + ".tmp.png"); os.replace(j["out"] + ".tmp.png", j["out"])
    print("card", j["type"], os.path.basename(j["out"]), flush=True)
