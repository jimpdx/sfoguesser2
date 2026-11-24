"""Build the chart-style base map (data/sfo/chart.svg) from OpenStreetMap.

Reads .cache/osm_sfo.json (tools/fetch_osm.py) and draws aprons,
taxiways, buildings, jet bridges and stand lead-in lines in the rotated
frame from data/sfo/airport.json, styled after an airport chart: black
field, gray pavement, white buildings.

Runways are not drawn here. They go to data/sfo/runways.json (width and
both thresholds with designators), and the app draws them on either base
map with an on/off toggle.

Usage: python -I tools/build_chart.py
"""
import json
import math
import pathlib
import re
import sys
from collections import defaultdict

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import CACHE, DATA, Frame, load_airport  # noqa: E402

DEFAULT_TWY_WIDTH = 23.0
JET_BRIDGE_WIDTH = 4.0

# The terminal ramps. OSM's apron polygons leave gaps between piers, so the
# chart also fills this outline (tools/ramp_outline.json, lat/lon). It runs
# along the centerlines of taxiways A, G and M1 and along the landside edge;
# taxiways are drawn on top in the same gray, so the edge only has to land
# within a taxiway's width.
RAMP_OUTLINE = pathlib.Path(__file__).resolve().parent / "ramp_outline.json"
# Landside center inside the terminal ring (roads, garages): left black.
LANDSIDE_CENTER = (37.616373, -122.386461)
LANDSIDE_RADIUS = 195

# Terminal names, written in the black center like the 10-9B does.
# Frame meters.
TEXT_LABELS = [
    ("TERMINAL 3", -55, -165),
    ("TERMINAL 2", 120, -60),
    ("TERMINAL 1", 95, 70),
    ("INTERNATIONAL", -95, 40),
    ("TERMINAL", -95, 58),
]

# Scoped under .sfo-chart because the app inlines this SVG into its page.
STYLE = """
.sfo-chart .apron, .sfo-chart .ramp { fill: #4d4d4d; fill-rule: evenodd; }
.sfo-chart .twy { fill: none; stroke: #4d4d4d; stroke-linecap: round; stroke-linejoin: round; }
.sfo-chart .bldg { fill: #262626; fill-rule: evenodd; }
.sfo-chart .terminal { fill: #f2f2f2; fill-rule: evenodd; }
.sfo-chart .jetbridge { fill: none; stroke: #f2f2f2; stroke-linecap: butt; }
.sfo-chart .leadin { fill: none; stroke: #8a8a8a; stroke-width: 0.6; }
.sfo-chart .lbl { font-family: Arial, Helvetica, sans-serif; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
.sfo-chart .lbl-term { fill: #d0d0d0; letter-spacing: 1px; }
"""


def fmt(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


class Builder:
    def __init__(self, airport, osm):
        self.frame = Frame.from_airport(airport)
        x0, y0, x1, y1 = airport["frame"]["bounds"]
        pad = 200
        self.bounds = (x0, y0, x1, y1)
        self.keep = (x0 - pad, y0 - pad, x1 + pad, y1 + pad)
        self.els = osm["elements"]

    def pts(self, geom):
        return [self.frame.to_frame(p["lat"], p["lon"]) for p in geom if p]

    def inside(self, pts):
        x0, y0, x1, y1 = self.keep
        return any(x0 <= x <= x1 and y0 <= y <= y1 for x, y in pts)

    @staticmethod
    def path(pts, close):
        d = "M" + " L".join(f"{fmt(x)} {fmt(y)}" for x, y in pts)
        return d + ("Z" if close else "")

    def rings(self, rel):
        """Join a multipolygon relation's member ways into closed rings."""
        segs = [[(p["lat"], p["lon"]) for p in m["geometry"] if p]
                for m in rel.get("members", []) if m.get("type") == "way" and m.get("geometry")]
        rings = []
        while segs:
            ring = segs.pop(0)
            changed = True
            while ring[0] != ring[-1] and changed:
                changed = False
                for i, s in enumerate(segs):
                    if s[0] == ring[-1]:
                        ring += s[1:]
                    elif s[-1] == ring[-1]:
                        ring += s[::-1][1:]
                    elif s[-1] == ring[0]:
                        ring = s[:-1] + ring
                    elif s[0] == ring[0]:
                        ring = s[::-1][:-1] + ring
                    else:
                        continue
                    segs.pop(i)
                    changed = True
                    break
            rings.append([self.frame.to_frame(lat, lon) for lat, lon in ring])
        return rings

    def ramp(self):
        ring = [self.frame.to_frame(lat, lon) for lat, lon in json.loads(RAMP_OUTLINE.read_text())]
        cx, cy = self.frame.to_frame(*LANDSIDE_CENTER)
        hole = [(cx + LANDSIDE_RADIUS * math.cos(a * math.pi / 36), cy + LANDSIDE_RADIUS * math.sin(a * math.pi / 36))
                for a in range(72)]
        return f'<path d="{self.path(ring, True)}{self.path(hole, True)}"/>', (cx, cy)

    def build(self):
        out = defaultdict(list)
        ramp_path, (hx, hy) = self.ramp()
        out["ramp"].append(ramp_path)
        for e in self.els:
            t = e.get("tags", {})
            aw = t.get("aeroway")
            if e["type"] == "way" and "geometry" in e:
                p = self.pts(e["geometry"])
                if not self.inside(p):
                    continue
                closed = e["geometry"][0] == e["geometry"][-1]
                if aw == "apron" and closed:
                    out["apron"].append(f'<path d="{self.path(p, True)}"/>')
                elif aw in ("taxiway", "taxilane"):
                    # pavement only; centerlines and letters are the app's
                    # Taxiways overlay (taxiways.json)
                    w = float(t.get("width", DEFAULT_TWY_WIDTH) or DEFAULT_TWY_WIDTH)
                    out["twy"].append(f'<path d="{self.path(p, False)}" stroke-width="{fmt(w)}"/>')
                elif aw == "runway":
                    pass  # runways are drawn by the app from runways.json
                elif aw == "jet_bridge":
                    out["jetbridge"].append(f'<path d="{self.path(p, closed)}" stroke-width="{JET_BRIDGE_WIDTH}"/>')
                elif aw == "parking_position":
                    out["leadin"].append(f'<path d="{self.path(p, False)}"/>')
                elif aw == "terminal" and closed:
                    out["terminal"].append(f'<path d="{self.path(p, True)}"/>')
                elif "building" in t and closed and aw != "jet_bridge":
                    mx = sum(q[0] for q in p) / len(p)
                    my = sum(q[1] for q in p) / len(p)
                    if math.hypot(mx - hx, my - hy) > LANDSIDE_RADIUS:
                        out["bldg"].append(f'<path d="{self.path(p, True)}"/>')
            elif e["type"] == "relation":
                rings = self.rings(e)
                if not rings or not any(self.inside(r) for r in rings):
                    continue
                d = "".join(self.path(r, True) for r in rings)
                if aw == "terminal":
                    out["terminal"].append(f'<path d="{d}"/>')
                elif aw == "apron":
                    out["apron"].append(f'<path d="{d}"/>')
                elif "building" in t:
                    out["bldg"].append(f'<path d="{d}"/>')

        labels = []
        for text, x, y in TEXT_LABELS:
            labels.append(f'<text class="lbl lbl-term" x="{fmt(x)}" y="{fmt(y)}" font-size="15">{text}</text>')

        x0, y0, x1, y1 = self.bounds
        parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" class="sfo-chart" viewBox="{x0} {y0} {x1 - x0} {y1 - y0}" '
            f'width="{x1 - x0}" height="{y1 - y0}">',
            f"<style>{STYLE}</style>",
            f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" fill="#050505"/>',
        ]
        for cls, key in (("ramp", "ramp"), ("apron", "apron"), ("twy", "twy"), ("leadin", "leadin"), ("bldg", "bldg"), ("terminal", "terminal"),
                         ("jetbridge", "jetbridge")):
            parts.append(f'<g class="{cls}">' + "".join(out[key]) + "</g>")
        parts.append('<g class="labels">' + "".join(labels) + "</g>")
        parts.append("</svg>")
        return "\n".join(parts), {k: len(v) for k, v in out.items()}


def seg_len(p):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(p, p[1:]))


def midpoint(p):
    half = seg_len(p) / 2
    for a, b in zip(p, p[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L >= half and L > 0:
            f = half / L
            return a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, math.atan2(b[1] - a[1], b[0] - a[0])
        half -= L
    return p[-1][0], p[-1][1], 0.0


def in_box(pt, box):
    return box[0] <= pt[0] <= box[2] and box[1] <= pt[1] <= box[3]


MAG_VAR = 13.5  # degrees east at SFO, only used to tell the two runway ends apart


def build_runways(osm):
    """One entry per runway: its width and both thresholds with their designators."""
    parts, widths = defaultdict(list), {}
    for e in osm["elements"]:
        t = e.get("tags", {})
        if e["type"] != "way" or t.get("aeroway") != "runway" or not t.get("ref"):
            continue
        g = e["geometry"]
        if g[0] == g[-1]:
            continue  # an area outline, not a centerline
        parts[t["ref"]].extend((p["lat"], p["lon"]) for p in g)
        widths[t["ref"]] = float(t.get("width", 61))

    def dist(a, b):
        return math.hypot(a[0] - b[0], (a[1] - b[1]) * math.cos(math.radians(a[0])))

    def diff(a, b):
        return abs((a - b + 180) % 360 - 180)

    out = []
    for ref, pts in sorted(parts.items()):
        a, b = max(((p, q) for p in pts for q in pts), key=lambda pq: dist(*pq))
        brg = math.degrees(math.atan2((b[1] - a[1]) * math.cos(math.radians(a[0])), b[0] - a[0])) % 360
        mag = (brg - MAG_VAR) % 360
        d1, d2 = ref.split("/")
        h1 = int("".join(c for c in d1 if c.isdigit())) * 10
        h2 = int("".join(c for c in d2 if c.isdigit())) * 10
        # the threshold you start from when rolling a->b carries the heading of a->b
        first, second = (a, b) if diff(mag, h1) <= diff(mag, h2) else (b, a)
        des1, des2 = d1.lstrip("0"), d2.lstrip("0")
        out.append({
            "id": f"{des1}/{des2}",
            "width": widths[ref],
            "ends": [
                {"des": des1, "lat": round(first[0], 7), "lon": round(first[1], 7)},
                {"des": des2, "lat": round(second[0], 7), "lon": round(second[1], 7)},
            ],
        })
    return out


TWY_NAME = re.compile(r"^[A-Z][0-9]?$")  # A, M1 ... (not spot lanes like 5A, not "UAL")
LABEL_EDGE = 30      # keep letters this far inside the frame (m)
LABEL_SAME = 380     # min spacing between two letters of one taxiway (m)
LABEL_ANY = 70       # min spacing between any two letters (m)
LABEL_RWY = 48       # keep letters off runway pavement (m from centerline)
LABEL_EVERY = 350    # extra letters along long taxiways (m)

# Letters lined up by hand where a row of taxiways crosses the same band,
# so the band reads like a chart. Frame meters: each letter goes where its
# taxiway crosses the line. "move" drops that taxiway's automatic letters;
# "add" keeps them, except any within 200 m of the new one.
ALIGNED = [
    # exits between runway 10R/28L (y -743) and taxiway B (y -624)
    {"refs": ["Q", "K", "D", "T", "E"], "y": -663, "mode": "move"},
    # east of B, halfway to runway 1L (B x 614, 1L x 735), north to south
    {"refs": ["W", "G", "H", "M", "M1"], "x": 665, "mode": "add"},
]

# Single letters moved by hand: the automatic letter of `ref` nearest the
# aligned letter `from_near` moves onto `ref`, centered between the aligned
# letters in `between`. Other letters of `ref` within 200 m are dropped.
MOVED = [
    # the B just west of K goes on B, centered between T and E
    {"ref": "B", "from_near": "K", "between": ["T", "E"]},
]


# Ramp entry lanes that carry a spot's name, drawn tidier than OSM has them:
# each starts at taxiway A and runs its LANE_LENGTHS meters into the ramp
# (trimmed, or extended straight if OSM's line is shorter), and is nudged
# sideways to pass through its spot marker (gates.json), since the 5 and 6
# spots are spread wider than the real lanes. Lanes 8 and 9 continue B4 and
# B5 across taxiway A, so their spots sit on the OSM lines instead.
# After editing, run: python -I tools/build_chart.py
LANE_LENGTHS = {
    **{lane: 200 for lane in ("5", "5A", "5B", "6", "6A", "6B", "7", "7A", "7B")},
    "8": 287.5,  # 250% of the earlier 115 m
    "9": 287.5,
}
SPOT_LANES = set(LANE_LENGTHS)
# Ramp A/B taxilanes trimmed so their north ends line up.
M_LANES = {"M3", "M4", "M5"}


def seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ((dx * dx + dy * dy) or 1e-9)))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def cut_at_length(p, length):
    """The first `length` meters of polyline p."""
    out, run = [p[0]], 0.0
    for a, b in zip(p, p[1:]):
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        if run + seg >= length:
            f = (length - run) / seg
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
            return out
        out.append(b)
        run += seg
    return out


def to_length(p, length):
    """Polyline p trimmed to `length` meters, or extended straight past its end."""
    total = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(p, p[1:]))
    if total >= length:
        return cut_at_length(p, length)
    back = cut_at_length(p, max(0.0, total - 40))[-1]
    ux, uy = p[-1][0] - back[0], p[-1][1] - back[1]
    n = math.hypot(ux, uy) or 1
    extra = length - total
    return p + [(p[-1][0] + ux / n * extra, p[-1][1] + uy / n * extra)]


def clip_north(p, y_end):
    """Polyline p from its south end up to y = y_end (y grows southward)."""
    if p[0][1] < p[-1][1]:
        p = p[::-1]
    out = [p[0]]
    for a, b in zip(p, p[1:]):
        if b[1] < y_end <= a[1]:
            f = (a[1] - y_end) / (a[1] - b[1])
            out.append((a[0] + (b[0] - a[0]) * f, y_end))
            return out
        out.append(b)
    return out


def tidy_lanes(raw, frame):
    a_lines = [p for r, p in raw if r == "A"]
    spots = {pt["id"]: frame.to_frame(pt["lat"], pt["lon"])
             for pt in json.loads((DATA / "gates.json").read_text(encoding="utf-8"))["points"]
             if pt["kind"] == "spot"}

    def from_a(pt):
        return min(seg_dist(pt, a, b) for p in a_lines for a, b in zip(p, p[1:]))

    out = []
    for ref, p in raw:
        if ref in SPOT_LANES:
            if from_a(p[-1]) < from_a(p[0]):
                p = p[::-1]  # start at taxiway A
            if ref in spots:
                # slide the lane sideways (across its straight far end) onto the spot
                total = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(p, p[1:]))
                far, back = p[-1], cut_at_length(p, max(0.0, total - 40))[-1]
                ux, uy = far[0] - back[0], far[1] - back[1]
                n = math.hypot(ux, uy) or 1
                ux, uy = ux / n, uy / n
                sx, sy = spots[ref][0] - far[0], spots[ref][1] - far[1]
                along = sx * ux + sy * uy
                dx, dy = sx - along * ux, sy - along * uy
                p = [(x + dx, y + dy) for x, y in p]
            p = to_length(p, LANE_LENGTHS[ref])
        out.append((ref, p))

    ms = [i for i, (ref, _) in enumerate(out) if ref in M_LANES]
    if ms:
        y_end = max(min(y for _, y in out[i][1]) for i in ms)  # the southernmost north end
        for i in ms:
            out[i] = (out[i][0], clip_north(out[i][1], y_end))
    return out


def build_taxiways(airport, osm, runways):
    """Taxiway centerlines plus where to put each taxiway's letter."""
    frame = Frame.from_airport(airport)
    x0, y0, x1, y1 = airport["frame"]["bounds"]
    pad = 150
    rwy_segs = [tuple(frame.to_frame(e["lat"], e["lon"]) for e in r["ends"]) for r in runways]

    def ok_spot(p):
        return (x0 + LABEL_EDGE <= p[0] <= x1 - LABEL_EDGE and y0 + LABEL_EDGE <= p[1] <= y1 - LABEL_EDGE
                and all(seg_dist(p, a, b) > LABEL_RWY for a, b in rwy_segs))

    def samples(p, step=10):
        """Points every `step` meters along a polyline, with distance from its start."""
        out, run = [], 0.0
        for a, b in zip(p, p[1:]):
            L = math.hypot(b[0] - a[0], b[1] - a[1])
            n = max(1, int(L // step))
            for i in range(n):
                f = i / n
                out.append((run + L * f, (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)))
            run += L
        out.append((run, p[-1]))
        return out

    raw = []  # (OSM ref, polyline in frame meters)
    for e in osm["elements"]:
        t = e.get("tags", {})
        if e["type"] != "way" or t.get("aeroway") not in ("taxiway", "taxilane"):
            continue
        p = [frame.to_frame(q["lat"], q["lon"]) for q in e["geometry"]]
        if not any(x0 - pad <= x <= x1 + pad and y0 - pad <= y <= y1 + pad for x, y in p):
            continue
        raw.append((t.get("ref", ""), p))
    raw = tidy_lanes(raw, frame)

    lines, cands, polys = [], defaultdict(list), defaultdict(list)
    for raw_ref, p in raw:
        ref = raw_ref if TWY_NAME.match(raw_ref) else None
        lines.append({"ref": ref, "pts": [[round(v, 6) for v in frame.from_frame(x, y)] for x, y in p]})
        if not ref:
            continue
        polys[ref].append(p)
        # candidate letter spots: runs of usable samples; their middles,
        # plus extra spots along long runs
        run = []
        for d, q in samples(p) + [(None, None)]:
            if q is not None and ok_spot(q):
                run.append((d, q))
                continue
            if len(run) >= 3:
                length = run[-1][0] - run[0][0]
                mid = run[0][0] + length / 2
                picks = [mid] + [run[0][0] + k for k in range(int(LABEL_EVERY / 2), int(length), LABEL_EVERY)]
                for target in picks:
                    q2 = min(run, key=lambda s: abs(s[0] - target))[1]
                    cands[ref].append((length, q2))
            run = []

    placed = []  # (ref, x, y)
    for ref in sorted(cands, key=lambda r: -max(c[0] for c in cands[r])):
        mine = []
        for length, q in sorted(cands[ref], key=lambda c: -c[0]):
            if any(math.hypot(q[0] - a, q[1] - b) < LABEL_SAME for a, b in mine):
                continue
            if any(math.hypot(q[0] - x, q[1] - y) < LABEL_ANY for _, x, y in placed):
                continue
            mine.append(q)
            placed.append((ref, *q))
        if not mine:  # every named taxiway in view gets at least one letter
            q = max(cands[ref], key=lambda c: c[0])[1]
            placed.append((ref, *q))

    def crossing(ref, axis, v):
        i = 1 if axis == "y" else 0
        for p in polys.get(ref, []):
            for a, b in zip(p, p[1:]):
                if a[i] != b[i] and (a[i] - v) * (b[i] - v) <= 0:
                    t = (v - a[i]) / (b[i] - a[i])
                    return a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])
        return None

    aligned = []
    for row in ALIGNED:
        axis = "y" if "y" in row else "x"
        for ref in row["refs"]:
            q = crossing(ref, axis, row[axis])
            if q is None:
                print(f"warning: taxiway {ref} doesn't cross {axis}={row[axis]}")
                continue
            if row["mode"] == "move":
                placed = [lb for lb in placed if lb[0] != ref]
            else:
                placed = [lb for lb in placed if lb[0] != ref or math.hypot(lb[1] - q[0], lb[2] - q[1]) > 200]
            aligned.append((ref, *q))

    def crossings(ref, axis, v):
        i = 1 if axis == "y" else 0
        out = []
        for p in polys.get(ref, []):
            for a, b in zip(p, p[1:]):
                if a[i] != b[i] and (a[i] - v) * (b[i] - v) <= 0:
                    t = (v - a[i]) / (b[i] - a[i])
                    out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
        return out

    for mv in MOVED:
        at = {a[0]: a for a in aligned}
        if mv["from_near"] not in at or any(r not in at for r in mv["between"]):
            print(f"warning: can't move {mv['ref']}: aligned letters missing")
            continue
        anchor = at[mv["from_near"]]
        ends = [at[r] for r in mv["between"]]
        mx = sum(e[1] for e in ends) / len(ends)
        my = sum(e[2] for e in ends) / len(ends)
        options = crossings(mv["ref"], "x", mx)
        if not options:
            print(f"warning: taxiway {mv['ref']} doesn't cross x={mx:.0f}")
            continue
        q = min(options, key=lambda c: abs(c[1] - my))
        mine = [lb for lb in placed if lb[0] == mv["ref"]]
        if mine:
            old = min(mine, key=lambda lb: math.hypot(lb[1] - anchor[1], lb[2] - anchor[2]))
            placed.remove(old)
        placed = [lb for lb in placed if lb[0] != mv["ref"] or math.hypot(lb[1] - q[0], lb[2] - q[1]) > 200]
        aligned.append((mv["ref"], *q))

    # hand-aligned letters win over any automatic letter crowding them
    placed = [lb for lb in placed
              if all(math.hypot(lb[1] - a[1], lb[2] - a[2]) >= LABEL_ANY for a in aligned)] + aligned

    labels = []
    for ref, x, y in placed:
        lat, lon = frame.from_frame(x, y)
        labels.append({"ref": ref, "lat": round(lat, 6), "lon": round(lon, 6)})
    labels.sort(key=lambda lb: (lb["ref"], lb["lat"]))
    return {"airport": "KSFO", "lines": lines, "labels": labels}


def main():
    airport = load_airport()
    osm = json.loads((CACHE / "osm_sfo.json").read_text(encoding="utf-8"))
    svg, counts = Builder(airport, osm).build()
    dest = DATA / "chart.svg"
    dest.write_text(svg, encoding="utf-8")
    print(counts)
    print(f"-> {dest} ({dest.stat().st_size // 1024} KB)")

    rwys = build_runways(osm)
    dest = DATA / "runways.json"
    dest.write_text(json.dumps({"airport": "KSFO", "runways": rwys}, indent=1) + "\n", encoding="utf-8")
    print("runways:", ", ".join(r["id"] for r in rwys), f"-> {dest}")

    twys = build_taxiways(airport, osm, rwys)
    dest = DATA / "taxiways.json"
    dest.write_text(json.dumps(twys, separators=(",", ":")) + "\n", encoding="utf-8")
    refs = sorted({lb["ref"] for lb in twys["labels"]})
    print(f"taxiways: {len(twys['lines'])} lines, {len(twys['labels'])} letters for {', '.join(refs)}"
          f" -> {dest} ({dest.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
