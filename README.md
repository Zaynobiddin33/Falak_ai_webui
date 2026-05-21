# Falak / SuvRadar AI — Demo Site

A Django + Channels web app that visualizes the **SuvRadar AI** (Falak) irrigation-risk model over the **Fergana Valley, Uzbekistan**.

- **Landing page** — 7-section marketing site matching the slide deck (problem → solution → data → model → product → why).
- **Dashboard** — Leaflet heatmap with a 1 km **Irrigation Risk Index (IRI)** grid. Click any cell to see its stats (NDVI, soil moisture, ET, rainfall anomaly, dominant crop, nearest river…).
- **Suv chat** — WebSocket-backed Gemini chat that grounds every reply in the **selected cell's stats**. Ask what to plant, what pests to expect, irrigation timing, animal threats — answers cite the cell's real numbers.
- **Mock ML service** — deterministic, spatially-coherent IRI/NDVI/moisture generator. Swap it for the real model service whenever you have one.

---

## Quick start

```bash
# 1. Create a venv and install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. Configure env
cp .env.example .env
# edit .env and (optionally) paste your GEMINI_API_KEY

# 3. Run migrations (sessions only)
python manage.py migrate

# 4. Start the ASGI server (Daphne — required for WebSockets)
daphne -b 0.0.0.0 -p 8000 falak.asgi:application
#  or, in dev:
python manage.py runserver 0.0.0.0:8000
```

Open <http://localhost:8000/> for the landing, <http://localhost:8000/dashboard/> for the dashboard.

> **Without a Gemini key**, the chat runs in **demo mode** — it returns a deterministic, helpful local answer that cites the selected cell's stats. The UI flow is fully testable.
>
> **With a key**, set `GEMINI_API_KEY` in `.env`. Get one at <https://aistudio.google.com/app/apikey>. The default model is `gemini-2.5-flash` (configurable via `GEMINI_MODEL`).

---

## Project layout

```
falak_site/
├── manage.py
├── requirements.txt
├── .env.example
├── falak/                 ← Django project
│   ├── settings.py
│   ├── asgi.py            ← ASGI w/ HTTP + WebSocket routing
│   ├── routing.py         ← ws/chat/ → ChatConsumer
│   └── urls.py
├── core/                  ← landing app
│   ├── views.py
│   └── templates/core/landing.html
├── dashboard/             ← try-using app
│   ├── views.py           ← page + REST endpoints
│   ├── urls.py
│   ├── consumers.py       ← WebSocket chat consumer
│   ├── gemini_client.py   ← async Gemini streaming wrapper
│   ├── ml_mock.py         ← per-cell IRI / NDVI / moisture mock generator
│   ├── regions.py         ← Fergana district + river anchors
│   └── templates/dashboard/dashboard.html
├── templates/base.html
└── static/
    ├── css/{base,landing,dashboard}.css
    └── js/{landing,map,stats,chat,dashboard}.js
```

---

## How it fits together

1. **Map** (`static/js/map.js`)
   - Leaflet centered on Fergana (40.65, 71.75), zoom 9.
   - Renders a per-cell colored 1 km grid using a fast client-side preview score (mirrors the server-side generator so colors match what the API returns).
   - On cell click, fetches the full per-cell stats from `GET /dashboard/api/cell/?lat=…&lng=…`.
2. **Stats strip** (`static/js/stats.js`)
   - Six cards (IRI, NDVI, moisture, rainfall, temperature, dominant crop) with 30-day sparklines via Chart.js.
3. **Chat panel** (`static/js/chat.js`)
   - Opens a WebSocket to `/ws/chat/`.
   - When a cell is selected, sends `{type: "select_cell", stats}` so the consumer knows what to ground the model on.
   - Sends user text via `{type: "user_message", text}` and renders streaming `ai_chunk` chunks back into the bubble.
4. **Consumer** (`dashboard/consumers.py`)
   - Async `AsyncJsonWebsocketConsumer`.
   - Stores the latest `cell_stats` in scope; prefixes the user message with a JSON `CELL_STATS` block so Gemini's reply always cites the selected area's numbers.
5. **Gemini client** (`dashboard/gemini_client.py`)
   - Uses the `google-genai` SDK and `generate_content_stream`.
   - Detailed `SYSTEM_INSTRUCTION` describing Fergana crops, regional pests, animals, irrigation logic.
   - Graceful fallback when no API key is set — keeps the demo functional without external calls.

---

## Switching to the real model

Replace `dashboard/ml_mock.py:compute_cell(lat, lng)` with a call to your SuvRadar-VFM inference service. The contract is a single dict shaped like:

```python
{
    "id": "UZB_…",
    "lat": 40.62, "lng": 71.74, "bounds": {…},
    "district": "Quva", "oblast": "Fergana", "area_ha": 100,
    "iri_score": 0.78, "stress_class": "HIGH",
    "priority_class": "HIGH", "inspection_window_h": 72,
    "ndvi": 0.42, "ndmi": 0.18, "ndwi": -0.12,
    "soil_moisture_pct": 14.3,
    "rainfall_30d_mm": 8.2, "rainfall_anomaly_pct": -62,
    "temperature_c": 28.4, "et_mm_day": 5.9,
    "elevation_m": 412, "distance_to_water_km": 4.8,
    "nearest_water": "South Fergana Canal",
    "dominant_crop": "Cotton",
    "history": {"ndvi": [...30d], "moisture": [...], "iri": [...], "rainfall": [...], "temperature": [...]},
}
```

Nothing else in the stack needs to change — the front-end binds to these keys.

---

## Deployment notes

- Use **Daphne** (or Uvicorn) as the ASGI server, not pure WSGI — WebSockets need it.
- For production, swap `InMemoryChannelLayer` for `channels-redis` and add a Redis service.
- `WhiteNoise` is already wired; run `python manage.py collectstatic` before deploy.
- Set `DEBUG=False`, configure `ALLOWED_HOSTS`, and generate a real `SECRET_KEY` in `.env`.

---

## License

MIT. Falak / SuvRadar AI · 2026.
