"""Download SFO airfield geometry from OpenStreetMap (Overpass API).

Writes the raw Overpass JSON to .cache/osm_sfo.json. The chart builder
(build_chart.py) turns it into the chart-style base map.

Usage: python -I tools/fetch_osm.py
"""
import json
import pathlib
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "osm_sfo.json"

# south, west, north, east: the airfield east of US-101
BBOX = "37.596,-122.408,37.636,-122.364"

QUERY = f"""
[out:json][timeout:120];
(
  node["aeroway"]({BBOX});
  way["aeroway"]({BBOX});
  relation["aeroway"]({BBOX});
  way["area:aeroway"]({BBOX});
  way["building"]({BBOX});
  relation["building"]({BBOX});
  way["natural"="water"]({BBOX});
  relation["natural"="water"]({BBOX});
  way["natural"="coastline"]({BBOX});
);
out geom;
"""


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=body,
        headers={"User-Agent": "sfoguesser2-chart-builder/0.1"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.load(resp)
    OUT.write_text(json.dumps(data), encoding="utf-8")
    print(f"{len(data['elements'])} elements -> {OUT}")


if __name__ == "__main__":
    main()
