"""Warp a north-up airport chart image into the app frame, for checking placements.

Point it at a chart image (for example a 10-9B screenshot) plus two
longitude ticks and two latitude ticks read off its border, and it writes
.cache/reference.png, aligned with data/sfo/satellite.webp. Edit mode
(index.html?edit) can show it over the map while you drag gates.

The output stays in .cache/ and is never published: charts are
copyrighted.

Usage:
  python -I tools/reference_overlay.py chart.webp \
      --lon 122.5=-122.398333 --lon 1353.5=-122.380 \
      --lat 147.5=37.621667 --lat 1419.5=37.606667 \
      --crop 28,95,1385,1560
"""
import argparse
import pathlib
import sys

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import CACHE, Frame, load_airport  # noqa: E402

RES = 0.5  # meters per output pixel, same as the satellite image


def pair(s):
    px, val = s.split("=")
    return float(px), float(val)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--lon", type=pair, action="append", required=True, help="PIXEL_X=LONGITUDE, twice")
    ap.add_argument("--lat", type=pair, action="append", required=True, help="PIXEL_Y=LATITUDE, twice")
    ap.add_argument("--crop", help="x0,y0,x1,y1 of the map area inside the chart border")
    args = ap.parse_args()

    (px1, lon1), (px2, lon2) = args.lon
    (py1, lat1), (py2, lat2) = args.lat

    def chart_px(lat, lon):
        return px1 + (lon - lon1) * (px2 - px1) / (lon2 - lon1), py1 + (lat - lat1) * (py2 - py1) / (lat2 - lat1)

    src = Image.open(args.image).convert("RGBA")
    if args.crop:
        x0c, y0c, x1c, y1c = (int(v) for v in args.crop.split(","))
        mask = Image.new("L", src.size, 0)
        mask.paste(255, (x0c, y0c, x1c, y1c))
        src.putalpha(mask)

    airport = load_airport()
    frame = Frame.from_airport(airport)
    x0, y0, x1, y1 = airport["frame"]["bounds"]
    w, h = round((x1 - x0) / RES), round((y1 - y0) / RES)

    def to_src(i, j):
        return chart_px(*frame.from_frame(x0 + i * RES, y0 + j * RES))

    p00, p10, p01 = to_src(0, 0), to_src(w, 0), to_src(0, h)
    coeffs = ((p10[0] - p00[0]) / w, (p01[0] - p00[0]) / h, p00[0],
              (p10[1] - p00[1]) / w, (p01[1] - p00[1]) / h, p00[1])
    out = src.transform((w, h), Image.AFFINE, coeffs, resample=Image.BICUBIC)
    CACHE.mkdir(exist_ok=True)
    dest = CACHE / "reference.png"
    out.save(dest)
    print(f"{w}x{h} -> {dest}")


if __name__ == "__main__":
    main()
