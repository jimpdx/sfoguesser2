"""Build the rotated satellite base image from Esri World Imagery tiles.

Downloads the z18 tiles that cover the frame (cached in .cache/tiles),
stitches them, and resamples them into the rotated frame defined in
data/sfo/airport.json. Writes data/sfo/satellite.webp.

Usage: python -I tools/build_imagery.py
"""
import concurrent.futures
import io
import math
import pathlib
import sys
import time
import urllib.request

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import CACHE, DATA, Frame, load_airport, mercator_px  # noqa: E402

Z = 18
RES = 0.5  # meters per output pixel
TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
TILES = CACHE / "tiles"


def fetch_tile(x, y):
    path = TILES / f"{Z}_{x}_{y}.jpg"
    if path.exists():
        return path
    url = TILE_URL.format(z=Z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": "sfoguesser2-imagery/0.1"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            Image.open(io.BytesIO(data)).verify()
            path.write_bytes(data)
            return path
        except Exception:
            time.sleep(1 + attempt * 2)
    raise RuntimeError(f"tile failed: {url}")


def main():
    airport = load_airport()
    frame = Frame.from_airport(airport)
    x0, y0, x1, y1 = airport["frame"]["bounds"]

    corners = [frame.from_frame(x, y) for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
    mpx = [mercator_px(lat, lon, Z) for lat, lon in corners]
    tx0 = int(min(p[0] for p in mpx) // 256)
    tx1 = int(max(p[0] for p in mpx) // 256)
    ty0 = int(min(p[1] for p in mpx) // 256)
    ty1 = int(max(p[1] for p in mpx) // 256)
    jobs = [(x, y) for x in range(tx0, tx1 + 1) for y in range(ty0, ty1 + 1)]
    print(f"{len(jobs)} tiles at z{Z}", flush=True)

    TILES.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        paths = dict(zip(jobs, pool.map(lambda j: fetch_tile(*j), jobs)))

    mosaic = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for (x, y), path in paths.items():
        mosaic.paste(Image.open(path).convert("RGB"), ((x - tx0) * 256, (y - ty0) * 256))

    # Map output pixel (i, j) -> mosaic pixel. The true mapping is affine to
    # well under a meter over this area, so fit it from three points.
    def src(i, j):
        lat, lon = frame.from_frame(x0 + i * RES, y0 + j * RES)
        mx, my = mercator_px(lat, lon, Z)
        return mx - tx0 * 256, my - ty0 * 256

    w = round((x1 - x0) / RES)
    h = round((y1 - y0) / RES)
    p00, p10, p01 = src(0, 0), src(w, 0), src(0, h)
    a = (p10[0] - p00[0]) / w
    d = (p10[1] - p00[1]) / w
    b = (p01[0] - p00[0]) / h
    e = (p01[1] - p00[1]) / h
    # check the far corner against the fit
    p11 = src(w, h)
    err = math.hypot(p00[0] + a * w + b * h - p11[0], p00[1] + d * w + e * h - p11[1])
    print(f"affine fit error at far corner: {err:.2f} mosaic px", flush=True)

    out = mosaic.transform((w, h), Image.AFFINE, (a, b, p00[0], d, e, p00[1]), resample=Image.BICUBIC)
    dest = DATA / "satellite.webp"
    out.save(dest, "WEBP", quality=70, method=6)
    print(f"{w}x{h} -> {dest} ({dest.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    sys.exit(main())
