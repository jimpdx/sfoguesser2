"""Seed data/sfo/gates.json from OpenStreetMap plus hand placements.

One-time helper. Once gates.json exists, maintain it in the app's edit
mode (index.html?edit) instead; this script refuses to overwrite it
unless you pass --force.

Placement rules, in order:
  1. MANUAL below (frame meters), for gates OSM lacks or gets wrong
  2. the stop end of the gate's OSM lead-in line (aeroway=parking_position)
  3. the outer tip of the gate's OSM jet bridge
Sub-positions (A4R, A4T, B5S ...) are not separate points: controllers
call them by the base gate.

Usage: python -I tools/seed_gates.py [--force]
"""
import argparse
import json
import math
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import CACHE, DATA, Frame, load_airport  # noqa: E402

AREAS = [
    {"id": "A", "name": "Boarding Area A", "terminal": "International Terminal"},
    {"id": "B", "name": "Boarding Area B", "terminal": "Harvey Milk Terminal 1"},
    {"id": "C", "name": "Boarding Area C", "terminal": "Harvey Milk Terminal 1"},
    {"id": "D", "name": "Boarding Area D", "terminal": "Terminal 2"},
    {"id": "E", "name": "Boarding Area E", "terminal": "Terminal 3"},
    {"id": "F", "name": "Boarding Area F", "terminal": "Terminal 3"},
    {"id": "G", "name": "Boarding Area G", "terminal": "International Terminal"},
    {"id": "spots", "name": "Spots", "terminal": "Ramp reporting points"},
]

# Gates on the 23 OCT 26 10-9B. No C2 (removed), no D13. No D2 either:
# closed when Southwest moved into Terminal 2 (jet bridge gone, the stand
# holds equipment); to bring it back, add it here and restore its MANUAL
# entry, (336, -266).
GATES = (
    [f"A{i}" for i in range(1, 16)]
    + [f"B{i}" for i in range(1, 28)]
    + ["C1"] + [f"C{i}" for i in range(3, 12)]
    + ["D1"] + [f"D{i}" for i in range(3, 13)] + ["D14", "D15", "D16"]
    + [f"E{i}" for i in range(1, 14)]
    + [f"F{i}" for i in range(1, 23)]
    + [f"G{i}" for i in range(1, 15)]
)

SPOTS = ["1", "2", "3", "4", "4A", "5", "5A", "5B", "6", "6A", "6B", "7", "7A", "7B", "8", "9", "10", "11"]

# Frame meters (x right, y down), read off the satellite image with the
# 10-9B overlaid (tools/reference_overlay.py).
MANUAL = {
    # Gates OSM lacks. E1 and F1-F4 are in the T3 West construction zone
    # (March 2026 imagery) and follow the chart's labels; G12 and G14 wrap
    # the G13 widebody stand.
    "E1": (-138, -312),
    # F1-F4: a column about 40 m apart along the T3 West face (the chart's
    # F4 label sits on the terminal roof in the photo)
    "F1": (-200, -66),
    "F2": (-198, -106),
    "F3": (-196, -146),
    "F4": (-194, -186),
    "G12": (-662, 48),
    "G14": (-688, 2),
    # Spots: the blue painted boxes visible in the imagery.
    "1": (451, 657),
    "2": (448, 742),
    "3": (245, 657),
    "4": (245, 742),
    "4A": (-64, 694),
    # The painted 5 and 6 boxes are about 21 m apart; these are spread to
    # the 7s' spacing (about 27 m) so they're easier to tell apart.
    "5": (486, -199),
    "5A": (486, -226),
    "5B": (486, -172),
    "6": (178, -498),
    "6A": (151, -498),
    "6B": (205, -498),
    "7": (-109, -498),
    "7A": (-137, -498),
    "7B": (-83, -498),
    # on the lane lines, which continue B4 and B5 straight across taxiway A
    "8": (-583, -207),
    "9": (-583, -132),
    # Plot 9 was reworked after the imagery date; these follow the chart.
    "10": (-668, -160),
    "11": (-725, -168),
}


# Labels go above markers except where neighbors crowd that space.
LABEL_SIDE = {"5": "right", "5A": "right", "5B": "right", "F20": "left", "F21": "left", "F22": "left"}


def natural(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    dest = DATA / "gates.json"
    if dest.exists() and not args.force:
        sys.exit(f"{dest} exists; edit it in the app (index.html?edit) or pass --force")

    airport = load_airport()
    frame = Frame.from_airport(airport)
    osm = json.loads((CACHE / "osm_sfo.json").read_text(encoding="utf-8"))

    gate_nodes, leadins, bridges = {}, {}, {}
    for e in osm["elements"]:
        t = e.get("tags", {})
        aw = t.get("aeroway")
        ref = (t.get("ref") or "").replace(" Jetway", "").strip()
        if aw == "gate" and e["type"] == "node" and ref:
            gate_nodes.setdefault(ref, frame.to_frame(e["lat"], e["lon"]))
        elif aw == "parking_position" and e["type"] == "way" and ref:
            leadins.setdefault(ref, []).append([frame.to_frame(p["lat"], p["lon"]) for p in e["geometry"]])
        elif aw == "jet_bridge" and e["type"] == "way" and ref:
            bridges.setdefault(ref, []).append([frame.to_frame(p["lat"], p["lon"]) for p in e["geometry"]])

    def near(pt, other):
        return math.hypot(pt[0] - other[0], pt[1] - other[1])

    points, missing = [], []
    for gid in GATES:
        anchor = gate_nodes.get(gid)
        how = None
        if gid in MANUAL:
            xy, how = MANUAL[gid], "manual"
        elif gid in leadins:
            # the lead-in end nearest the terminal is where the nose stops
            ends = [p for line in leadins[gid] for p in (line[0], line[-1])]
            ref_pt = anchor or (sum(p[0] for p in ends) / len(ends), sum(p[1] for p in ends) / len(ends))
            xy, how = min(ends, key=lambda p: near(p, ref_pt)), "leadin"
        elif gid in bridges and anchor:
            tips = [p for line in bridges[gid] for p in (line[0], line[-1])]
            xy, how = max(tips, key=lambda p: near(p, anchor)), "jetbridge"
        elif anchor:
            xy, how = anchor, "gate-node"
        else:
            missing.append(gid)
            continue
        lat, lon = frame.from_frame(*xy)
        points.append({"id": gid, "kind": "gate", "area": gid[0], "lat": round(lat, 7), "lon": round(lon, 7), "src": how})

    for sid in SPOTS:
        if sid in MANUAL:
            lat, lon = frame.from_frame(*MANUAL[sid])
            points.append({"id": sid, "kind": "spot", "area": "spots", "lat": round(lat, 7), "lon": round(lon, 7), "src": "manual"})
        else:
            missing.append(sid)

    for p in points:
        if p["id"] in LABEL_SIDE:
            p["label"] = LABEL_SIDE[p["id"]]
    points.sort(key=lambda p: (p["kind"] != "gate", natural(p["id"])))
    data = {
        "airport": "KSFO",
        "chart": airport["chartRef"],
        "areas": AREAS,
        "points": points,
    }
    dest.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    counts = {}
    for p in points:
        counts[p["src"]] = counts.get(p["src"], 0) + 1
    print(f"{len(points)} points -> {dest}; by source {counts}")
    print("missing:", missing)


if __name__ == "__main__":
    main()
