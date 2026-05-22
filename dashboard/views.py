import json
import math
import urllib.parse
import urllib.request
from functools import lru_cache
from pathlib import Path

from django.conf import settings
from django.http import HttpResponseBadRequest, JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_GET

from .ml_mock import compute_cell, compute_priority_list
from .regions import AOI, DISTRICTS, nearest_district, nearest_water


SUVRADAR_DIR = Path(settings.BASE_DIR) / "static" / "suvradar"
SUVRADAR_POINTS = SUVRADAR_DIR / "suvradar_latest_fergana_points.json"
SUVRADAR_LEGACY_GEOJSON = SUVRADAR_DIR / "suvradar_latest_fergana_h7_h14_10000.geojson"
SUVRADAR_SUMMARY = SUVRADAR_DIR / "latest_summary.json"


def dashboard(request):
    return render(request, "dashboard/dashboard.html", {
        "aoi": json.dumps(AOI),
        "districts": json.dumps(DISTRICTS),
    })


def _as_float(value, default=0.0):
    try:
        if value is None:
            return default
        value = float(value)
        if math.isnan(value) or value <= -999:
            return default
        return value
    except (TypeError, ValueError):
        return default


def _stress_class(raw_iri):
    if raw_iri >= 55:
        return "HIGH"
    if raw_iri >= 40:
        return "MEDIUM"
    return "LOW"


def _inspection_window_h(raw_iri):
    if raw_iri >= 55:
        return 72
    if raw_iri >= 45:
        return 120
    return None


def _crop_label(row):
    crop = _as_float(row.get("crop") or row.get("dw_crops"))
    water = _as_float(row.get("water") or row.get("dw_water"))
    built = _as_float(row.get("built") or row.get("dw_built"))
    if water >= 0.25:
        return "Water / canal edge"
    if crop >= 0.30:
        return "Cropland"
    if built >= 0.25:
        return "Built / settlement"
    if crop >= 0.08:
        return "Mixed agriculture"
    return "Bare / pasture"


def _flat_series(base, n=30):
    return [round(base, 3) for _ in range(n)]


def _last_n(values, n=30):
    values = [value for value in values if value is not None]
    values = values[-n:]
    if len(values) < n:
        values = ([values[0]] * (n - len(values))) + values if values else [0.0] * n
    return [round(_as_float(value), 3) for value in values]


def _daily_means_from_hourly(times, values, n=30):
    grouped = {}
    for timestamp, value in zip(times or [], values or []):
        if value is None:
            continue
        grouped.setdefault(str(timestamp)[:10], []).append(_as_float(value))
    days = []
    for date in sorted(grouped):
        day_values = grouped[date]
        days.append(sum(day_values) / max(1, len(day_values)))
    return _last_n(days, n=n)


@lru_cache(maxsize=1024)
def _open_meteo_history(lat_key, lng_key):
    query = urllib.parse.urlencode({
        "latitude": lat_key,
        "longitude": lng_key,
        "daily": ",".join([
            "precipitation_sum",
            "temperature_2m_max",
            "et0_fao_evapotranspiration",
        ]),
        "hourly": "soil_moisture_9_to_27cm",
        "past_days": 30,
        "forecast_days": 1,
        "timezone": "auto",
    })
    url = f"https://api.open-meteo.com/v1/forecast?{query}"
    with urllib.request.urlopen(url, timeout=4) as response:
        payload = json.loads(response.read().decode("utf-8"))

    daily = payload.get("daily") or {}
    hourly = payload.get("hourly") or {}
    return {
        "rainfall": _last_n(daily.get("precipitation_sum") or []),
        "temperature": _last_n(daily.get("temperature_2m_max") or []),
        "et": _last_n(daily.get("et0_fao_evapotranspiration") or []),
        "moisture": [
            round(value * 100, 3)
            for value in _daily_means_from_hourly(
                hourly.get("time") or [],
                hourly.get("soil_moisture_9_to_27cm") or [],
            )
        ],
    }


def _real_history(lat, lng, ndvi, moisture_pct, rainfall, temperature, et):
    fallback = {
        "ndvi": _flat_series(ndvi),
        "moisture": _flat_series(moisture_pct),
        "rainfall": _flat_series(rainfall / 30 if rainfall else 0.0),
        "temperature": _flat_series(temperature),
        "et": _flat_series(et),
    }
    try:
        history = _open_meteo_history(round(lat, 2), round(lng, 2))
    except Exception:
        return fallback

    history["ndvi"] = fallback["ndvi"]
    return history


@lru_cache(maxsize=1)
def _real_cells():
    if SUVRADAR_POINTS.exists():
        with SUVRADAR_POINTS.open() as f:
            data = json.load(f)
        fields = data.get("fields") or []
        cells = []
        for values in data.get("cells", []):
            row = {name: values[index] for index, name in enumerate(fields) if index < len(values)}
            row["lat"] = row.get("lat")
            row["lng"] = row.get("lon")
            cells.append(row)
        return cells

    if SUVRADAR_LEGACY_GEOJSON.exists():
        with SUVRADAR_LEGACY_GEOJSON.open() as f:
            data = json.load(f)
        cells = []
        for feature in data.get("features", []):
            props = feature.get("properties", {})
            cells.append({
                "lat": props.get("center_lat"),
                "lng": props.get("center_lon"),
                "h7": props.get("suvradar_iri_h7"),
                "h14": props.get("suvradar_iri_h14"),
                "ndvi": props.get("ndvi"),
                "ndmi": props.get("ndmi"),
                "ndwi": props.get("ndwi"),
                "sm": props.get("smap_soil_moisture_am"),
                "rain": props.get("rainfall_30d_mm"),
                "rain_anom": props.get("rainfall_30d_mm_anomaly"),
                "temp": props.get("era5_temp_2m_max_c"),
                "et": _as_float(props.get("era5_potential_et_mm")) / 10,
                "crop": props.get("dw_crops"),
                "water": props.get("dw_water"),
                "built": props.get("dw_built"),
            })
        return cells

    return []


@lru_cache(maxsize=1)
def _real_summary():
    if not SUVRADAR_SUMMARY.exists():
        return {}
    with SUVRADAR_SUMMARY.open() as f:
        return json.load(f)


def _cell_to_stats(row, horizon_days=7):
    lat = _as_float(row.get("lat"))
    lng = _as_float(row.get("lng"))
    h7 = _as_float(row.get("h7"), 50)
    h14 = _as_float(row.get("h14"), h7)
    raw_iri = h14 if horizon_days == 14 else h7
    district = nearest_district(lat, lng)
    water, distance_km = nearest_water(lat, lng)
    moisture_pct = _as_float(row.get("sm")) * 100
    ndvi = _as_float(row.get("ndvi"))
    rainfall = _as_float(row.get("rain"))
    temperature = _as_float(row.get("temp"), 25)
    et = _as_float(row.get("et"), 4)
    stress = _stress_class(raw_iri)

    return {
        "id": f"UZB_{lat:.4f}_{lng:.4f}",
        "lat": round(lat, 5),
        "lng": round(lng, 5),
        "bounds": {},
        "district": district["name"],
        "oblast": district["country_oblast"],
        "area_ha": 100,
        "iri_score": round(raw_iri / 100, 3),
        "forecast_iri_h7": round(h7, 2),
        "forecast_iri_h14": round(h14, 2),
        "model_horizon_days": horizon_days,
        "stress_class": stress,
        "priority_class": stress,
        "inspection_window_h": _inspection_window_h(raw_iri),
        "ndvi": round(ndvi, 3),
        "ndmi": round(_as_float(row.get("ndmi")), 3),
        "ndwi": round(_as_float(row.get("ndwi")), 3),
        "soil_moisture_pct": round(moisture_pct, 1),
        "rainfall_30d_mm": round(rainfall, 1),
        "rainfall_anomaly_pct": round(_as_float(row.get("rain_anom")), 1),
        "temperature_c": round(temperature, 1),
        "et_mm_day": round(et, 2),
        "elevation_m": 0,
        "distance_to_water_km": round(distance_km, 2),
        "nearest_water": water["name"],
        "dominant_crop": _crop_label(row),
        "history": _real_history(lat, lng, ndvi, moisture_pct, rainfall, temperature, et),
    }


def _nearest_real_cell(lat, lng):
    best = None
    best_distance = float("inf")
    for row in _real_cells():
        cell_lat = _as_float(row.get("lat"))
        cell_lng = _as_float(row.get("lng"))
        distance = (cell_lat - lat) ** 2 + (cell_lng - lng) ** 2
        if distance < best_distance:
            best = row
            best_distance = distance
    return best


@require_GET
def api_cell(request):
    try:
        lat = float(request.GET["lat"])
        lng = float(request.GET["lng"])
    except (KeyError, ValueError, TypeError):
        return HttpResponseBadRequest("lat and lng query params required")

    if not (AOI["bounds"]["south"] - 0.5 < lat < AOI["bounds"]["north"] + 0.5):
        return HttpResponseBadRequest("lat outside AOI")
    if not (AOI["bounds"]["west"] - 0.5 < lng < AOI["bounds"]["east"] + 0.5):
        return HttpResponseBadRequest("lng outside AOI")

    horizon = request.GET.get("horizon", "7")
    horizon_days = 14 if horizon in {"14", "h14"} else 7
    row = _nearest_real_cell(lat, lng)
    if row:
        return JsonResponse(_cell_to_stats(row, horizon_days=horizon_days))

    return JsonResponse(compute_cell(lat, lng))


@require_GET
def api_priority(request):
    cells = _real_cells()
    if cells:
        grouped = {}
        for row in cells:
            lat = _as_float(row.get("lat"))
            lng = _as_float(row.get("lng"))
            score = _as_float(row.get("h7"), 50)
            district = nearest_district(lat, lng)
            item = grouped.setdefault(
                district["name"],
                {"district": district["name"], "oblast": district["country_oblast"], "scores": []},
            )
            item["scores"].append(score)

        districts = []
        for item in grouped.values():
            scores = item.pop("scores")
            mean_iri = sum(scores) / max(1, len(scores))
            risk = _stress_class(mean_iri)
            item.update({
                "mean_iri": round(mean_iri, 2),
                "risk": risk,
                "hectares_at_risk": int(sum(1 for score in scores if score >= 55) * 100),
            })
            districts.append(item)
        districts.sort(key=lambda item: -item["mean_iri"])
        return JsonResponse({"districts": districts})

    return JsonResponse({"districts": compute_priority_list()})


@require_GET
def api_aoi(request):
    return JsonResponse({"aoi": AOI, "districts": DISTRICTS})


@require_GET
def api_suvradar_summary(request):
    return JsonResponse(_real_summary() or {"status": "missing"})
