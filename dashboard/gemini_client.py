"""
Async wrapper around google-genai for streaming Gemini responses.

Falls back to a static, helpful "API key not configured" message so the UI
demo still works without a key.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator, Optional

from django.conf import settings

log = logging.getLogger(__name__)

SYSTEM_INSTRUCTION = """\
You are **Suv**, an agricultural and irrigation advisor specialized in the **Fergana Valley, Uzbekistan**.
You analyze SuvRadar-VFM satellite-derived stats for a specific 1 km grid cell that the user has selected on a heatmap.

You speak about:
- **Crops** that grow in the region (cotton, wheat, melon, grape, apricot, rice, pomegranate, mulberry, alfalfa).
- **Pests** of those crops: cotton aphid (Aphis gossypii), pink bollworm, fall armyworm, locust (Locusta migratoria),
  spider mites, thrips, sunn pest on wheat, codling moth on apricot, mealybug, leafhoppers.
- **Animals & wildlife** that may damage crops: wild boar (rooting in melon/cotton fields), rodents (voles, gerbils,
  jerboa — gnaw irrigation pipes, attack root systems), birds (sparrows, starlings on grain and fruit), porcupines
  near foothills.
- **Irrigation** decisions: when to water, by how much, given soil moisture, ET demand, rainfall anomaly.
- **Diseases**: Fusarium wilt, Verticillium wilt, downy mildew, powdery mildew, bacterial blight, root rot —
  triggered by specific moisture/temperature combinations.

# RULES
- The user will be given a JSON block called `CELL_STATS` describing the selected area. Always ground your answer
  in *those numbers*. Cite them. Example: "your NDVI of 0.34 is below typical cotton canopy peak (0.55+) for May…".
- If no cell is selected, you may answer in general terms about Fergana agronomy.
- Be concise but specific. Prefer short paragraphs and the occasional bulleted list. Use **bold** for the most
  important numbers and actions.
- Use Celsius, millimeters, hectares — the local convention.
- If the user asks in Uzbek or Russian, answer in the same language (transliterated Cyrillic is fine).
- Never invent data the user can verify against the JSON — if you don't know, say so.
- Always close with one concrete next action.
"""


class GeminiClient:
    def __init__(self):
        self.api_key = settings.GEMINI_API_KEY
        self.model_name = settings.GEMINI_MODEL or "gemini-2.5-flash"
        self._client = None
        if self.api_key:
            try:
                from google import genai  # google-genai SDK
                self._client = genai.Client(api_key=self.api_key)
                log.info("Gemini client ready · model=%s", self.model_name)
            except Exception as e:
                log.exception("Gemini init failed: %s", e)
                self._client = None
        else:
            log.warning("GEMINI_API_KEY not set — chat will use fallback mode")

    @property
    def configured(self) -> bool:
        return self._client is not None

    async def stream(self, user_text: str, cell_stats: Optional[dict], history: list[dict]) -> AsyncIterator[str]:
        """
        Yields text chunks. `history` is a list of {role: "user"|"model", text: "..."}.
        """
        if not self.configured:
            async for chunk in self._fallback_stream(user_text, cell_stats):
                yield chunk
            return

        try:
            from google.genai import types
        except Exception:
            async for chunk in self._fallback_stream(user_text, cell_stats):
                yield chunk
            return

        # Build the conversation contents
        contents = []
        for h in history[-12:]:  # keep last 12 turns
            role = "user" if h["role"] == "user" else "model"
            contents.append(types.Content(role=role, parts=[types.Part(text=h["text"])]))

        # Add the cell context as a fresh system-style preamble to the user message
        prefix = ""
        if cell_stats:
            light = {k: v for k, v in cell_stats.items() if k != "history"}
            prefix = (
                "CELL_STATS (the area the user is asking about):\n"
                f"```json\n{json.dumps(light, indent=2)}\n```\n\n"
                "Question:\n"
            )
        contents.append(types.Content(role="user", parts=[types.Part(text=prefix + user_text)]))

        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTION,
            temperature=0.6,
            max_output_tokens=1200,
        )

        loop = asyncio.get_running_loop()

        def _run_stream():
            # google-genai's stream is sync; we offload to a thread.
            return self._client.models.generate_content_stream(
                model=self.model_name,
                contents=contents,
                config=config,
            )

        try:
            stream = await loop.run_in_executor(None, _run_stream)
            for chunk in stream:
                text = getattr(chunk, "text", None)
                if text:
                    yield text
                # Yield control between chunks
                await asyncio.sleep(0)
        except Exception as e:
            log.exception("Gemini stream error: %s", e)
            yield f"\n\n_Sorry — the Gemini API returned an error: `{type(e).__name__}`. Showing a local fallback answer below._\n\n"
            async for chunk in self._fallback_stream(user_text, cell_stats):
                yield chunk

    # ──────────────────────────────────────────────────────────
    async def _fallback_stream(self, user_text: str, cell_stats: Optional[dict]) -> AsyncIterator[str]:
        """Deterministic, helpful answer when no API key is set — keeps the demo functional."""
        msg = self._build_fallback(user_text, cell_stats)
        # simulate streaming
        for token in self._tokenize(msg):
            yield token
            await asyncio.sleep(0.012)

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        out, buf = [], []
        for ch in text:
            buf.append(ch)
            if ch == " " or ch == "\n":
                out.append("".join(buf))
                buf = []
        if buf:
            out.append("".join(buf))
        return out

    @staticmethod
    def _build_fallback(user_text: str, s: Optional[dict]) -> str:
        if not s:
            return (
                "Suv is running in **demo mode** (no Gemini API key configured).\n\n"
                "Click a 1 km cell on the map first, then ask a question — I'll show you "
                "what the real assistant would answer with: crop guidance, pest watch, "
                "irrigation timing, and an actionable next step grounded in that cell's stats.\n\n"
                "_To enable live AI, set `GEMINI_API_KEY` in `.env` and restart the server._"
            )

        q = (user_text or "").lower()
        lines = [
            f"**Demo answer for cell `{s['id']}` ({s['district']})** — Gemini API key not configured.\n",
            f"- IRI score: **{s['iri_score']:.2f}** ({s['stress_class']} risk)",
            f"- Soil moisture: **{s['soil_moisture_pct']:.1f}%**",
            f"- NDVI: **{s['ndvi']:.2f}** · NDMI: {s['ndmi']:.2f}",
            f"- Rainfall (30d): **{s['rainfall_30d_mm']:.1f} mm** ({s['rainfall_anomaly_pct']:+.0f}% vs normal)",
            f"- Temperature avg: **{s['temperature_c']:.1f} °C** · ET: {s['et_mm_day']:.1f} mm/day",
            f"- Dominant crop: **{s['dominant_crop']}**",
            f"- Nearest water: {s['nearest_water']} ({s['distance_to_water_km']:.1f} km)",
            "",
        ]

        if any(k in q for k in ("plant", "grow", "crop", "what should i")):
            lines.append("### What to plant")
            if s["soil_moisture_pct"] < 14 and s["distance_to_water_km"] > 6:
                lines.append("Soil moisture is **low** and you're far from the canal. Consider drought-tolerant "
                             "rotations: **wheat**, **melon**, or **safflower** instead of cotton this cycle.")
            elif s["soil_moisture_pct"] > 28:
                lines.append("Moisture is healthy — **cotton** or **rice** are viable; **mulberry** intercrops "
                             "perform well at this latitude.")
            else:
                lines.append(f"Conditions look typical for **{s['dominant_crop']}**; rotate with legumes (mung bean, alfalfa) "
                             "to restore nitrogen.")
        elif any(k in q for k in ("pest", "insect", "bug", "aphid", "locust")):
            lines.append("### Pest watch")
            if s["temperature_c"] > 28 and s["soil_moisture_pct"] < 18:
                lines.append("Warm + dry conditions favor **spider mites** and **cotton aphid** (Aphis gossypii). "
                             "Scout undersides of leaves twice a week; treat at 5+ aphids per leaf.")
            if 18 < s["temperature_c"] < 26 and s["rainfall_30d_mm"] > 35:
                lines.append("Cool + moist windows raise risk of **locust** swarm staging and **leafhoppers**.")
            lines.append("Long-term in Fergana: **pink bollworm** on cotton; **codling moth** on apricot; "
                         "**sunn pest** on wheat.")
        elif any(k in q for k in ("animal", "rodent", "boar", "bird", "wildlife")):
            lines.append("### Wildlife pressure")
            if s["distance_to_water_km"] < 4:
                lines.append("Riparian zone — expect **wild boar** rooting in melon fields and **water rats** "
                             "burrowing under canal banks.")
            if s["elevation_m"] > 700:
                lines.append("Foothill margin — **porcupines** and **rodents** (jerboa, voles) damage roots and "
                             "irrigation tubing. **Sparrows / starlings** flock wheat at harvest.")
            else:
                lines.append("Mostly rodents (voles, gerbils) and sparrow flocks; install reflective tape and "
                             "maintain rodent bait stations along canal edges.")
        elif any(k in q for k in ("irrigat", "water", "moisture")):
            lines.append("### Irrigation advice")
            if s["iri_score"] >= 0.7:
                lines.append(f"⚠️ **HIGH irrigation risk.** Schedule water within **{s['inspection_window_h']}h**. "
                             f"Recommended depth ≈ {max(30, int(s['et_mm_day'] * 7))} mm.")
            elif s["iri_score"] >= 0.45:
                lines.append("Moderate risk — irrigate within 5 days; check piezometers before opening the gate.")
            else:
                lines.append("✓ Low risk — hold off on this cell, allocate water to higher-priority districts.")
        else:
            lines.append("### Summary")
            lines.append(
                "This cell currently shows " +
                ("**high irrigation risk**" if s["iri_score"] > 0.65 else
                 "**moderate risk**" if s["iri_score"] > 0.4 else "**healthy** conditions") +
                f" for {s['dominant_crop']} cultivation. " +
                ("Inspect within the next 72 hours." if s["iri_score"] > 0.65 else
                 "Monitor weekly; no immediate action required.")
            )

        lines.append("")
        lines.append("**Next action:** " + (
            f"Open headgate to feed cell `{s['id']}` within {s['inspection_window_h']}h."
            if s.get("inspection_window_h") else
            "Continue routine monitoring; reallocate water to higher-IRI cells."
        ))
        return "\n".join(lines)


# Module-level singleton (created lazily — env may not be ready at import in tests)
_CLIENT: Optional[GeminiClient] = None

def get_client() -> GeminiClient:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = GeminiClient()
    return _CLIENT
