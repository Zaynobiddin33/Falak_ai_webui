"""
Async wrapper around the Groq SDK for streaming LLM responses.

Falls back to a deterministic Uzbek answer (built from the selected cell's stats)
when the GROQ_API_KEY is not set — so the UI demo still works without a key.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator, Optional

from django.conf import settings

log = logging.getLogger(__name__)

SYSTEM_INSTRUCTION = """\
Sen **Suv**san — **Farg'ona vodiysi, O'zbekiston** uchun sug'orish va agronomiya bo'yicha maslahatchisan.
Sen FALAK-VFM sun'iy yo'ldosh modeli tomonidan hisoblangan, foydalanuvchi xaritada tanlagan 1 km katak
ma'lumotlarini tahlil qilasan.

Senga quyidagilar haqida gapiramiz:
- **Ekinlar** (mintaqada o'sadigan): paxta, bug'doy, qovun, uzum, o'rik, sholi, anor, tut, beda.
- **Zararkunandalar**: paxta shirasi (Aphis gossypii), pushti ko'sak qurti, kuzgi tunlam, chigirtka (Locusta migratoria),
  o'rgimchaksimon kanalar, tripslar, bug'doy hidli buti, o'rikning olma qurti, qoramoyaklar, sikadalar.
- **Hayvonlar va yovvoyi tabiat**: yovvoyi cho'chqa (qovun va paxta dalalarini agdaradi), kemiruvchilar
  (sichqonlar, qumsichqon, jerboa — sug'orish quvurlarini kemirib, ildizlarga hujum qiladi), qushlar (chumchuq,
  qoraqush — don va meva uchun), tikan-cho'chqalar (tog' etagiga yaqin).
- **Sug'orish qarorlari**: tuproq namligi, ET talabi va yog'in anomaliyasiga qarab qachon va qancha suv berish.
- **Kasalliklar**: Fusarium so'lishi, Verticillium so'lishi, peronosporoz, kul kasalligi, bakterial yondirgi,
  ildiz chirishi — ma'lum namlik/harorat kombinatsiyalari ostida rivojlanadi.

# QOIDALAR
- Foydalanuvchiga `CELL_STATS` deb nomlangan JSON blok beriladi. Javobingni har doim **shu raqamlarga** asoslantir
  va ularni keltir. Masalan: "sizning NDVI 0.34 — may oyida paxta uchun odatdagi 0.55+ darajasidan past…".
- Agar katak tanlanmagan bo'lsa, Farg'ona agronomiyasi haqida umumiy javob ber.
- Aniq va qisqa bo'l. Qisqa paragraflar va kerak bo'lganda nuqtalangan ro'yxat ishlat. Eng muhim raqam va
  harakatlar uchun **qalin** matn ishlat.
- Selsiy, millimetr, gektarda gapir — mahalliy konventsiya.
- **Standart javob tili — O'zbek (lotin yozuvi)**. Agar foydalanuvchi rus, ingliz yoki kirill yozuvida yozsa,
  shu tilda javob ber.
- Hech qachon JSON'da yo'q ma'lumotni o'ylab chiqarma — bilmasangiz, ochiq ayting.
- Javobni har doim bitta aniq keyingi harakat bilan yakunla.
"""


class AIClient:
    """Groq chat client — streaming, async."""

    provider = "groq"

    def __init__(self):
        self.api_key = settings.GROQ_API_KEY
        self.model_name = settings.GROQ_MODEL or "llama-3.3-70b-versatile"
        self._client = None
        if self.api_key:
            try:
                from groq import AsyncGroq
                self._client = AsyncGroq(api_key=self.api_key)
                log.info("Groq client ready · model=%s", self.model_name)
            except Exception as e:
                log.exception("Groq init failed: %s", e)
                self._client = None
        else:
            log.warning("GROQ_API_KEY not set — chat will use the local Uzbek fallback")

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

        # Build the OpenAI-style messages list
        messages = [{"role": "system", "content": SYSTEM_INSTRUCTION}]
        for h in history[-12:]:
            role = "user" if h["role"] == "user" else "assistant"
            messages.append({"role": role, "content": h["text"]})

        # Prepend the cell-stats JSON to the current user message so the model is grounded
        if cell_stats:
            light = {k: v for k, v in cell_stats.items() if k != "history"}
            prefix = (
                "CELL_STATS (foydalanuvchi tanlagan hudud):\n"
                f"```json\n{json.dumps(light, indent=2, ensure_ascii=False)}\n```\n\n"
                "Savol:\n"
            )
            messages.append({"role": "user", "content": prefix + user_text})
        else:
            messages.append({"role": "user", "content": user_text})

        try:
            stream = await self._client.chat.completions.create(
                model=self.model_name,
                messages=messages,
                temperature=0.6,
                max_tokens=1200,
                stream=True,
            )
            async for chunk in stream:
                try:
                    delta = chunk.choices[0].delta.content
                except (IndexError, AttributeError):
                    delta = None
                if delta:
                    yield delta
        except Exception as e:
            log.exception("Groq stream error: %s", e)
            yield (
                f"\n\n_Kechirasiz — Groq API xatoligi: `{type(e).__name__}`. "
                "Quyida mahalliy fallback javob ko'rsatilmoqda._\n\n"
            )
            async for chunk in self._fallback_stream(user_text, cell_stats):
                yield chunk

    # ──────────────────────────────────────────────────────────
    async def _fallback_stream(self, user_text: str, cell_stats: Optional[dict]) -> AsyncIterator[str]:
        """Deterministic Uzbek answer — keeps the demo functional without a key."""
        msg = self._build_fallback(user_text, cell_stats)
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
                "Suv **demo rejimida** ishlamoqda (Groq API kaliti sozlanmagan).\n\n"
                "Avval xaritadan 1 km katakni tanlang va savol bering — haqiqiy yordamchi "
                "shu katakning ma'lumotlariga asoslangan holda nima ekish, qaysi zararkunandalarni kuzatish, "
                "qachon sug'orish va keyingi aniq harakatni aytib beradi.\n\n"
                "_Jonli AI'ni yoqish uchun `.env` faylida `GROQ_API_KEY` ni o'rnating va serverni qayta ishga tushiring._"
            )

        stress_uz = {"HIGH": "YUQORI", "MEDIUM": "O'RTACHA", "LOW": "PAST"}.get(s["stress_class"], s["stress_class"])
        q = (user_text or "").lower()
        lines = [
            f"**Demo javob — katak `{s['id']}` ({s['district']})** · Groq API kaliti sozlanmagan.\n",
            f"- Stress balli: **{s['iri_score']:.2f}** ({stress_uz} xavf)",
            f"- Tuproq namligi: **{s['soil_moisture_pct']:.1f}%**",
            f"- NDVI: **{s['ndvi']:.2f}** · NDMI: {s['ndmi']:.2f}",
            f"- Yog'in (30 kun): **{s['rainfall_30d_mm']:.1f} mm** (me'yorga nisbatan {s['rainfall_anomaly_pct']:+.0f}%)",
            f"- O'rtacha harorat: **{s['temperature_c']:.1f} °C** · Bug'lanish: {s['et_mm_day']:.1f} mm/kun",
            f"- Eng yaqin suv: {s['nearest_water']} ({s['distance_to_water_km']:.1f} km)",
            "",
        ]

        # Topic matchers — Uzbek + English. Most specific topics first; "plant" is the most
        # ambiguous (contains generic words) so it must be matched last.
        pest_kw   = ("zararkunanda", "shira", "qurti", "tunlam", "chigirtka", "o'rgimchak",
                     "pest", "insect", "aphid", "locust", "mite")
        animal_kw = ("hayvon", "cho'chqa", "sichqon", "qush", "kemiruvchi", "yovvoyi", "qoraqush",
                     "animal", "rodent", "boar", "bird", "wildlife")
        irrig_kw  = ("sug'or", "namlik", "irrigat", "moisture")
        plant_kw  = ("ekish", "ekin", "nima ek", "ek mumkin", "plant", "grow", "crop", "what should i")

        if any(k in q for k in pest_kw):
            lines.append("### Zararkunandalar nazorati")
            if s["temperature_c"] > 28 and s["soil_moisture_pct"] < 18:
                lines.append("Issiq + quruq sharoit **o'rgimchaksimon kanalar** va **paxta shirasi**ga qulay. "
                             "Barg orqasini haftada ikki marta tekshiring; bargga 5+ shira bo'lsa, ishlov bering.")
            if 18 < s["temperature_c"] < 26 and s["rainfall_30d_mm"] > 35:
                lines.append("Salqin + nam oyna **chigirtka** to'planishi va **sikadalar** xavfini oshiradi.")
            lines.append("Farg'onada uzoq muddat: paxtada **pushti ko'sak qurti**; o'rikda **olma qurti**; "
                         "bug'doyda **hidli buti**.")
        elif any(k in q for k in animal_kw):
            lines.append("### Yovvoyi tabiat bosimi")
            if s["distance_to_water_km"] < 4:
                lines.append("Daryo bo'yi zonasi — qovun dalalarini kovlovchi **yovvoyi cho'chqa** va kanal "
                             "qirg'oqlarini o'yuvchi **suv kalamushlari** kutiladi.")
            if s["elevation_m"] > 700:
                lines.append("Tog' etagi — **tipratikan** va **kemiruvchilar** (jerboa, sichqonlar) ildiz va "
                             "sug'orish quvurlariga zarar yetkazadi. Hosil paytida **chumchuq/qoraqush** to'dalari bug'doyga tushadi.")
            else:
                lines.append("Asosan kemiruvchilar (sichqon, qumsichqon) va chumchuq to'dalari; aks ettiruvchi "
                             "lentalar o'rnating va kanal bo'ylarida zaharli yem stantsiyalarini ushlab turing.")
        elif any(k in q for k in irrig_kw):
            lines.append("### Sug'orish maslahati")
            if s["iri_score"] >= 0.7:
                lines.append(f"⚠️ **YUQORI sug'orish xavfi.** Suvni **{s['inspection_window_h']} soat** ichida rejalashtiring. "
                             f"Tavsiya etilgan chuqurlik ≈ {max(30, int(s['et_mm_day'] * 7))} mm.")
            elif s["iri_score"] >= 0.45:
                lines.append("O'rtacha xavf — 5 kun ichida sug'oring; eshikni ochishdan oldin pezometrlarni tekshiring.")
            else:
                lines.append("✓ Past xavf — bu katakni ushlab turing, suvni yuqoriroq xavfli tumanlarga yo'naltiring.")
        elif any(k in q for k in plant_kw):
            lines.append("### Nima ekish mumkin")
            if s["soil_moisture_pct"] < 14 and s["distance_to_water_km"] > 6:
                lines.append("Tuproq namligi **past** va kanaldan uzoqdasiz. Bu sikl uchun paxta o'rniga "
                             "**bug'doy**, **qovun** yoki **safflower** kabi qurg'oqchilikka chidamli almashinuvni ko'rib chiqing.")
            elif s["soil_moisture_pct"] > 28:
                lines.append("Namlik sog'lom — **paxta** yoki **sholi** mos keladi; **tut** interkroplari "
                             "shu kenglikda yaxshi natija beradi.")
            else:
                lines.append(f"Sharoit shu mavsumda **paxta** uchun odatiy; azotni tiklash uchun dukkakli o'simliklar "
                             "(mosh, beda) bilan almashinuv qiling.")
        else:
            lines.append("### Xulosa")
            verdict = ("**yuqori sug'orish xavfi**" if s["iri_score"] > 0.65 else
                       "**o'rtacha xavf**"        if s["iri_score"] > 0.40 else "**sog'lom** sharoit")
            tail = ("Keyingi 72 soat ichida tekshiring." if s["iri_score"] > 0.65 else
                    "Haftalik kuzating; tezkor harakat shart emas.")
            lines.append(f"Bu katakda hozir {verdict} kuzatilmoqda. {tail}")

        lines.append("")
        lines.append("**Keyingi harakat:** " + (
            f"`{s['id']}` katagiga {s['inspection_window_h']} soat ichida suv yo'naltiring."
            if s.get("inspection_window_h") else
            "Doimiy kuzatuvni davom ettiring; suvni yuqori xavfli kataklarga qayta taqsimlang."
        ))
        return "\n".join(lines)


# Module-level singleton — env may not be ready at import time during tests
_CLIENT: Optional[AIClient] = None

def get_client() -> AIClient:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = AIClient()
    return _CLIENT
