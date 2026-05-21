"""
Fergana Valley district anchor points and AOI bounds.
Real coordinates (rough centroids) — used by the mock ML generator
and the map to label cells with their parent district.
"""

# Fergana Valley AOI (roughly: lat 40.0–41.4, lng 70.4–73.2)
AOI = {
    "name": "Fergana Valley",
    "country": "Uzbekistan",
    "bounds": {
        "south": 40.10,
        "north": 41.20,
        "west": 70.50,
        "east": 73.00,
    },
    "center": {"lat": 40.65, "lng": 71.75},
    "default_zoom": 9,
}

DISTRICTS = [
    {"name": "Quva",      "lat": 40.521, "lng": 72.082, "country_oblast": "Fergana"},
    {"name": "Yazyavan",  "lat": 40.616, "lng": 71.700, "country_oblast": "Fergana"},
    {"name": "Rishton",   "lat": 40.358, "lng": 71.282, "country_oblast": "Fergana"},
    {"name": "Dang'ara",  "lat": 40.498, "lng": 70.927, "country_oblast": "Fergana"},
    {"name": "Oltiariq",  "lat": 40.376, "lng": 71.235, "country_oblast": "Fergana"},
    {"name": "Marg'ilon", "lat": 40.471, "lng": 71.724, "country_oblast": "Fergana"},
    {"name": "Fergana",   "lat": 40.389, "lng": 71.787, "country_oblast": "Fergana"},
    {"name": "Andijon",   "lat": 40.781, "lng": 72.348, "country_oblast": "Andijon"},
    {"name": "Asaka",     "lat": 40.642, "lng": 72.243, "country_oblast": "Andijon"},
    {"name": "Namangan",  "lat": 40.998, "lng": 71.673, "country_oblast": "Namangan"},
    {"name": "Chust",     "lat": 41.000, "lng": 71.232, "country_oblast": "Namangan"},
    {"name": "Pop",       "lat": 40.875, "lng": 70.945, "country_oblast": "Namangan"},
]

# Major rivers / canals (approximate mid-points) — used for distance features
WATER_ANCHORS = [
    {"name": "Syr Darya",        "lat": 40.880, "lng": 71.450},
    {"name": "Kara Darya",       "lat": 40.770, "lng": 72.500},
    {"name": "Naryn (upper)",    "lat": 40.965, "lng": 71.080},
    {"name": "South Fergana Canal", "lat": 40.380, "lng": 71.450},
    {"name": "Big Fergana Canal",   "lat": 40.620, "lng": 71.300},
]


def nearest_district(lat: float, lng: float) -> dict:
    best = None
    best_d = float("inf")
    for d in DISTRICTS:
        dd = (d["lat"] - lat) ** 2 + (d["lng"] - lng) ** 2
        if dd < best_d:
            best_d = dd
            best = d
    return best


def nearest_water(lat: float, lng: float) -> tuple[dict, float]:
    """Return (anchor, approximate km)."""
    best = None
    best_d = float("inf")
    for w in WATER_ANCHORS:
        dd = (w["lat"] - lat) ** 2 + (w["lng"] - lng) ** 2
        if dd < best_d:
            best_d = dd
            best = w
    # 1 degree ≈ 111 km, but mix lat/lng — close enough for a mock
    km = (best_d ** 0.5) * 95.0
    return best, km
