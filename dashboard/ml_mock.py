"""
Mock SuvRadar-VFM output for a 1 km grid cell.

Generates deterministic, spatially-coherent stats that look like real model
predictions: smooth NDVI patches, soil-moisture pockets near rivers, IRI hot
zones around drought-prone districts. Swap this module out for the real model
service when wired up.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import asdict, dataclass
from typing import Optional

from .regions import AOI, nearest_district, nearest_water

# Cell size in degrees. ~1 km at this latitude.
CELL_DEG = 0.01

CROPS_BY_ZONE = [
    # (rule_fn, crop_name)
    ("low_elev_central",  "Cotton"),
    ("low_elev_west",     "Wheat"),
    ("near_water",        "Rice"),
    ("foothill_south",    "Pomegranate"),
    ("foothill_north",    "Apricot"),
    ("dry_east",          "Melon"),
    ("vine_strip",        "Grape"),
]


def _seed(lat: float, lng: float, salt: str = "") -> float:
    """Stable pseudo-random number in [0, 1] from a coordinate."""
    key = f"{lat:.4f},{lng:.4f},{salt}".encode()
    h = hashlib.md5(key).digest()
    n = int.from_bytes(h[:4], "big")
    return n / 0xFFFFFFFF


def _smooth(lat: float, lng: float, freq: float, phase: float) -> float:
    """Smooth-noise field in [-1, 1] for spatial coherence."""
    return (
        math.sin(lat * freq + phase) * math.cos(lng * freq * 0.9 - phase * 0.7)
        + 0.4 * math.sin(lat * freq * 2.3 - phase) * math.cos(lng * freq * 1.7)
    ) / 1.4


def _bound(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def _pick_crop(lat: float, lng: float, distance_to_water_km: float, elev: int) -> str:
    """Heuristic crop assignment for realism."""
    n = _seed(lat, lng, "crop")
    if distance_to_water_km < 2.5 and n > 0.4:
        return "Rice"
    if elev > 800:
        return "Apricot" if lat > 40.7 else "Pomegranate"
    if lng > 72.4 and n > 0.55:
        return "Melon"
    if 0.25 < n < 0.40:
        return "Grape"
    if n > 0.7:
        return "Wheat"
    return "Cotton"


def cell_id_for(lat: float, lng: float) -> str:
    """Stable ID, snapped to the cell grid origin."""
    snap_lat = math.floor(lat / CELL_DEG) * CELL_DEG
    snap_lng = math.floor(lng / CELL_DEG) * CELL_DEG
    return f"UZB_{int(snap_lat * 1000):05d}_{int(snap_lng * 1000):05d}"


def snap_cell_bounds(lat: float, lng: float) -> dict:
    s_lat = math.floor(lat / CELL_DEG) * CELL_DEG
    s_lng = math.floor(lng / CELL_DEG) * CELL_DEG
    return {
        "south": round(s_lat, 5),
        "north": round(s_lat + CELL_DEG, 5),
        "west":  round(s_lng, 5),
        "east":  round(s_lng + CELL_DEG, 5),
    }


def _stress_class(iri: float) -> str:
    if iri >= 0.66: return "HIGH"
    if iri >= 0.40: return "MEDIUM"
    return "LOW"


def _priority(iri: float, area_ha: float) -> str:
    if iri >= 0.7: return "HIGH"
    if iri >= 0.45: return "MEDIUM"
    return "LOW"


def _inspection_window_h(iri: float) -> Optional[int]:
    if iri >= 0.7: return 72
    if iri >= 0.45: return 120
    return None


def _sparkline(seed_lat: float, seed_lng: float, salt: str, base: float, amp: float, n: int = 30) -> list[float]:
    """30-day daily series. Smooth-ish so charts look real."""
    out = []
    for i in range(n):
        r = _seed(seed_lat, seed_lng, f"{salt}_{i}")
        # day-over-day correlated walk
        v = base + amp * math.sin(i * 0.42 + r * 6.28) + (r - 0.5) * amp * 0.4
        out.append(round(v, 3))
    return out


@dataclass
class CellStats:
    id: str
    lat: float
    lng: float
    bounds: dict
    district: str
    oblast: str
    area_ha: float

    iri_score: float            # 0–1, higher = more risk
    stress_class: str
    priority_class: str
    inspection_window_h: Optional[int]

    ndvi: float
    ndmi: float
    ndwi: float
    soil_moisture_pct: float
    rainfall_30d_mm: float
    rainfall_anomaly_pct: float
    temperature_c: float
    et_mm_day: float
    elevation_m: int
    distance_to_water_km: float
    nearest_water: str
    dominant_crop: str

    history: dict


def compute_cell(lat: float, lng: float) -> dict:
    """Returns a dict of mocked-but-realistic stats for the cell containing (lat, lng)."""
    bounds = snap_cell_bounds(lat, lng)
    c_lat = (bounds["south"] + bounds["north"]) / 2
    c_lng = (bounds["east"] + bounds["west"]) / 2

    district = nearest_district(c_lat, c_lng)
    water, dist_km = nearest_water(c_lat, c_lng)

    # ─── Underlying smooth fields ─────────────────────────────────────────
    # NOTE: these formulas are mirrored client-side in static/js/map.js::previewScore
    # for fast in-browser cell coloring. If you change anything below, update map.js too.
    ndvi_field = 0.45 + 0.35 * _smooth(c_lat, c_lng, freq=18, phase=1.7)   # 0.1 – 0.8
    moisture_field = 0.30 + 0.25 * _smooth(c_lat, c_lng, freq=12, phase=3.1)
    heat_field = 0.5 + 0.3 * _smooth(c_lat, c_lng, freq=8, phase=0.6)      # higher = hotter
    rainfall_field = 0.5 + 0.4 * _smooth(c_lat, c_lng, freq=6, phase=2.4)

    moisture = _bound(moisture_field + (_seed(c_lat, c_lng, "m") - 0.5) * 0.08, 0.04, 0.45)

    ndvi = _bound(ndvi_field + (moisture - 0.25) * 0.4, 0.05, 0.9)
    ndmi = _bound(ndvi - 0.2 + moisture * 0.4 - 0.1, -0.2, 0.6)
    ndwi = _bound(0.05 + moisture * 0.8 - 0.5, -0.4, 0.6)

    rainfall_30d_mm = _bound(rainfall_field * 50, 1, 90)
    rainfall_anomaly_pct = round(-100 + rainfall_30d_mm / 35.0 * 100, 1)  # roughly -90..+150
    temperature_c = round(18 + heat_field * 18, 1)                       # 18..36 °C
    et = round(2 + heat_field * 5, 2)                                    # 2..7 mm/day
    elevation_m = int(380 + _seed(c_lat, c_lng, "e") * 700 + max(0, c_lat - 40.6) * 1400)

    # Stress / IRI score: combines low moisture, low NDVI, rainfall deficit, high ET.
    # Mirrored in map.js::previewScore.
    iri = _bound(
        0.45 * (1 - moisture / 0.45)
        + 0.20 * (1 - ndvi)
        + 0.20 * max(0, -rainfall_anomaly_pct) / 100
        + 0.15 * et / 7
    )

    crop = _pick_crop(c_lat, c_lng, dist_km, elevation_m)
    area_ha = 100.0  # 1 km^2

    stats = CellStats(
        id=cell_id_for(c_lat, c_lng),
        lat=round(c_lat, 5),
        lng=round(c_lng, 5),
        bounds=bounds,
        district=district["name"],
        oblast=district["country_oblast"],
        area_ha=area_ha,

        iri_score=round(iri, 3),
        stress_class=_stress_class(iri),
        priority_class=_priority(iri, area_ha),
        inspection_window_h=_inspection_window_h(iri),

        ndvi=round(ndvi, 3),
        ndmi=round(ndmi, 3),
        ndwi=round(ndwi, 3),
        soil_moisture_pct=round(moisture * 100, 1),
        rainfall_30d_mm=round(rainfall_30d_mm, 1),
        rainfall_anomaly_pct=rainfall_anomaly_pct,
        temperature_c=temperature_c,
        et_mm_day=et,
        elevation_m=elevation_m,
        distance_to_water_km=round(dist_km, 2),
        nearest_water=water["name"],
        dominant_crop=crop,

        history={
            "ndvi":        _sparkline(c_lat, c_lng, "h_ndvi", ndvi, 0.06),
            "moisture":    _sparkline(c_lat, c_lng, "h_moist", moisture * 100, 5),
            "rainfall":    _sparkline(c_lat, c_lng, "h_rain", rainfall_30d_mm / 30, 1.2),
            "temperature": _sparkline(c_lat, c_lng, "h_t", temperature_c, 2.5),
            "et":          _sparkline(c_lat, c_lng, "h_et", et, 0.6),
        },
    )
    return asdict(stats)


def compute_priority_list() -> list[dict]:
    """Aggregate IRI across cells in each district for the right-side priority list."""
    from .regions import DISTRICTS
    out = []
    for d in DISTRICTS:
        # Sample 9 cells around the district centroid
        scores = []
        for dy in (-0.04, 0, 0.04):
            for dx in (-0.04, 0, 0.04):
                s = compute_cell(d["lat"] + dy, d["lng"] + dx)
                scores.append(s["iri_score"])
        mean_iri = sum(scores) / len(scores)
        ha_at_risk = int(800 + mean_iri * 800)
        out.append({
            "district": d["name"],
            "oblast": d["country_oblast"],
            "mean_iri": round(mean_iri, 3),
            "risk": _stress_class(mean_iri),
            "hectares_at_risk": ha_at_risk,
        })
    out.sort(key=lambda x: -x["mean_iri"])
    return out
