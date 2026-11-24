"""Shared projection for the build tools.

The app draws everything in a flat "frame" measured in meters:
  - origin at CENTER (the middle of the terminal complex)
  - rotated so runways 1/19 run straight up and down and 10/28 straight
    across, the way the ASDE-X display is oriented
  - x grows to the right, y grows downward (SVG convention)

app.js has the same math (toFrame / fromFrame); keep the two in sync.
"""
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
DATA = ROOT / "data" / "sfo"

EARTH_R = 6378137.0


def load_airport():
    return json.loads((DATA / "airport.json").read_text(encoding="utf-8"))


class Frame:
    def __init__(self, lat0, lon0, rotation_deg):
        self.lat0 = lat0
        self.lon0 = lon0
        self.theta = math.radians(rotation_deg)
        self.kx = EARTH_R * math.cos(math.radians(lat0)) * math.pi / 180
        self.ky = EARTH_R * math.pi / 180

    @classmethod
    def from_airport(cls, airport):
        f = airport["frame"]
        return cls(f["center"][0], f["center"][1], f["rotation"])

    def to_frame(self, lat, lon):
        e = (lon - self.lon0) * self.kx
        n = (lat - self.lat0) * self.ky
        c, s = math.cos(self.theta), math.sin(self.theta)
        x = e * c - n * s
        y = -(e * s + n * c)
        return x, y

    def from_frame(self, x, y):
        c, s = math.cos(self.theta), math.sin(self.theta)
        up = -y
        e = x * c + up * s
        n = -x * s + up * c
        return self.lat0 + n / self.ky, self.lon0 + e / self.kx


def mercator_px(lat, lon, z):
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    r = math.radians(lat)
    y = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n
    return x, y
