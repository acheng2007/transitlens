"""
voice-service — POST /api/voice/ask

Takes a spoken question plus the plane the user is looking at, builds a prompt
with that plane as context, asks Grok (xAI), and returns a short spoken-friendly
answer. See root CLAUDE.md for the contract.

Run:  uvicorn main:app --port 8002 --reload
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

import httpx2 as httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).parent / ".env")
log = logging.getLogger("voice-service")
logging.basicConfig(level=logging.INFO)

XAI_API_KEY = os.getenv("XAI_API_KEY", "")
# grok-4-fast was retired by xAI on 2026-05-15; grok-4.3 is its replacement.
XAI_MODEL = os.getenv("XAI_MODEL", "grok-4.3")
XAI_BASE_URL = os.getenv("XAI_BASE_URL", "https://api.x.ai/v1")
# Optional: "none" | "low" | "medium" | "high". grok-4.3 defaults to "low"; "none" answers fastest.
# Leave unset for providers that don't support it (e.g. Gemini).
XAI_REASONING_EFFORT = os.getenv("XAI_REASONING_EFFORT", "").strip()
# Grok text-to-speech (https://docs.x.ai/developers/model-capabilities/audio/text-to-speech).
# Always talks to xAI, even if chat is pointed at another provider; needs an xAI key.
XAI_TTS_URL = os.getenv("XAI_TTS_URL", "https://api.x.ai/v1/tts")
XAI_TTS_API_KEY = os.getenv("XAI_TTS_API_KEY", "") or (XAI_API_KEY if "x.ai" in XAI_BASE_URL else "")
XAI_TTS_VOICE = os.getenv("XAI_TTS_VOICE", "leo")  # eve | ara | leo | rex | sal
FIXTURE_PATH = Path(__file__).parent.parent / "shared" / "fixtures" / "demo-planes.json"

# ---------------------------------------------------------------------------
# Models (mirror the `Plane` contract in CLAUDE.md; everything optional except
# position/distance/bearing, but we stay lenient so a partial plane never 422s)
# ---------------------------------------------------------------------------


class Plane(BaseModel):
    id: str
    callsign: Optional[str] = None
    registration: Optional[str] = None
    typeCode: Optional[str] = None
    typeName: Optional[str] = None
    airline: Optional[str] = None
    origin: Optional[str] = None
    destination: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    altitudeFt: Optional[float] = None
    groundSpeedKt: Optional[float] = None
    trackDeg: Optional[float] = None
    distanceKm: Optional[float] = None
    bearingDeg: Optional[float] = None
    offsetDeg: Optional[float] = None  # signed angle from where the user is facing; negative = left
    category: Optional[str] = None  # raw ADS-B emitter category, e.g. "A7" = rotorcraft
    kind: Optional[str] = None  # "plane" | "helicopter"
    onGround: Optional[bool] = None
    emergency: Optional[str] = None  # "general" | "minfuel" | "nordo" | "unlawful" | "downed"
    military: Optional[bool] = None
    medical: Optional[bool] = None


class AskRequest(BaseModel):
    question: str
    plane: Optional[Plane] = None
    nearbyPlanes: list[Plane] = Field(default_factory=list)
    # Convenience for curl testing: resolve a plane by id/callsign from the demo
    # fixture when the caller doesn't send a full `plane` object.
    planeId: Optional[str] = None


class AskResponse(BaseModel):
    answer: str


class SpeakRequest(BaseModel):
    text: str


# ---------------------------------------------------------------------------
# Plane lookup (fixture only — the web app normally sends the full plane)
# ---------------------------------------------------------------------------


def _load_fixture_planes() -> list[dict[str, Any]]:
    try:
        return json.loads(FIXTURE_PATH.read_text(encoding="utf-8")).get("planes", [])
    except Exception as e:  # noqa: BLE001
        log.warning("could not read fixture %s: %s", FIXTURE_PATH, e)
        return []


def find_plane(plane_id: str) -> Optional[Plane]:
    key = plane_id.strip().lower()
    for p in _load_fixture_planes():
        if key in {str(p.get("id", "")).lower(), str(p.get("callsign") or "").lower()}:
            return Plane(**p)
    return None


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are Grok, a witty aviation buddy living inside an AR headset. \
The user is looking up at the sky at a plane and just asked you a question out loud.

Rules:
- Your answer is read aloud by text-to-speech. Reply in plain spoken English: \
1 to 3 short sentences, no markdown, no lists, no emojis, no abbreviations that sound odd spoken.
- Use the plane data provided as the source of truth for what the user is looking at. \
Don't invent flight numbers, routes, or airlines that aren't in the data. \
If a field is missing, say you don't know that detail (briefly) and move on.
- You may use general aviation knowledge for questions the data can't answer \
(e.g. how many seats an A321 has, how fast a 737 cruises, what an airline is).
- Say airport codes as their city or airport name when you know it (ATL -> Atlanta, LGA -> LaGuardia).
- Be fun and a little punchy, but accurate. Never lecture.

Context for reasoning about what a plane is doing:
- The user is standing on the Georgia Tech campus in Atlanta, about 15 km north of \
Hartsfield-Jackson airport (ATL). Nearly every airliner they see is arriving at or \
departing from ATL.
- Flight phase: a plane whose destination is ATL and altitude is under ~10,000 ft is \
descending to land. A plane whose origin is ATL at low altitude is climbing out. \
"On the ground" means it is taxiing or parked at ATL, not flying. Don't say a plane \
is "climbing" or "just took off" unless the origin is ATL or the route is unknown \
and the altitude is low; when unsure, don't guess the phase at all.
- "Kind: helicopter" means it is a helicopter even when the type is unknown; call it \
a helicopter, never a plane. Medical helicopters are typically air ambulances.
- Mention emergency, military, or medical flags when set; they are interesting. \
Skip them when not set.
- "Position in view" tells you where the aircraft is relative to the way the user is \
facing; use it only if it helps ("just to your left").
"""


def _fmt(v: Any, unit: str = "") -> str:
    if v is None:
        return "unknown"
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return f"{v}{unit}"


def _position_in_view(offset: Optional[float]) -> str:
    if offset is None:
        return "unknown"
    if abs(offset) < 5:
        return "straight ahead"
    side = "left" if offset < 0 else "right"
    return f"{abs(offset):.0f} degrees to the {side}"


def describe_plane(p: Plane, label: str = "Aircraft the user is looking at") -> str:
    flags = [name for name, on in (("EMERGENCY: " + str(p.emergency), bool(p.emergency)),
                                    ("military", bool(p.military)),
                                    ("medical / air ambulance", bool(p.medical))) if on]
    lines = [
        f"{label}:",
        f"  Kind: {_fmt(p.kind)}",
        f"  ICAO hex id: {p.id}",
        f"  Callsign / flight: {_fmt(p.callsign)}",
        f"  Registration (tail number): {_fmt(p.registration)}",
        f"  Aircraft: {_fmt(p.typeName)} (type code {_fmt(p.typeCode)})",
        f"  On the ground: {'yes' if p.onGround else 'no' if p.onGround is not None else 'unknown'}",
        f"  Special flags: {', '.join(flags) if flags else 'none'}",
        f"  Airline: {_fmt(p.airline)}",
        f"  Route: {_fmt(p.origin)} -> {_fmt(p.destination)}",
        f"  Altitude: {_fmt(p.altitudeFt, ' ft')}",
        f"  Ground speed: {_fmt(p.groundSpeedKt, ' knots')}",
        f"  Heading (track): {_fmt(p.trackDeg, ' degrees')}",
        f"  Distance from user: {_fmt(p.distanceKm, ' km')}",
        f"  Bearing from user: {_fmt(p.bearingDeg, ' degrees')}",
        f"  Position in view: {_position_in_view(p.offsetDeg)}",
    ]
    return "\n".join(lines)


def build_messages(req: AskRequest, plane: Optional[Plane]) -> list[dict[str, str]]:
    if plane is None:
        context = (
            "No plane is currently in the user's view. If they ask about 'that plane', "
            "tell them you don't see one right now and suggest they look around."
        )
    else:
        context = describe_plane(plane)

    if req.nearbyPlanes:
        others = [p for p in req.nearbyPlanes if not plane or p.id != plane.id]
        if others:
            context += "\n\nOther planes nearby (not centered):\n" + "\n".join(
                f"  - {_fmt(p.callsign)} ({p.typeName or p.typeCode or p.kind or 'unknown type'}), "
                f"{_fmt(p.distanceKm, ' km')} away, bearing {_fmt(p.bearingDeg)}"
                for p in others[:8]
            )

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"{context}\n\nUser's question: {req.question.strip()}"},
    ]


# ---------------------------------------------------------------------------
# LLM call with an offline fallback (demo must never die)
# ---------------------------------------------------------------------------


def fallback_answer(req: AskRequest, plane: Optional[Plane]) -> str:
    if plane is None:
        return "I don't see a plane right now. Try looking around the sky."
    who = plane.callsign or plane.registration or "an aircraft"
    what = plane.typeName or plane.typeCode or ("helicopter" if plane.kind == "helicopter" else "unknown type")
    if plane.medical:
        what = f"medical {what}"
    bits = [f"That's {who}, {('a ' if what[0].lower() not in 'aeiou' else 'an ') + what}"]
    if plane.airline:
        bits[0] += f" operated by {plane.airline}"
    bits[0] += "."
    if plane.origin or plane.destination:
        bits.append(f"It's flying from {plane.origin or 'somewhere'} to {plane.destination or 'somewhere'}.")
    if plane.onGround:
        bits.append("It's on the ground right now.")
    elif plane.altitudeFt is not None:
        bits.append(f"It's at about {int(plane.altitudeFt):,} feet.")
    return " ".join(bits)


async def ask_grok(messages: list[dict[str, str]]) -> str:
    from openai import AsyncOpenAI  # lazy import keeps startup snappy

    # Short timeout + one retry: a spoken answer that arrives late is worse than the
    # canned fallback. Gemini free tier throws occasional 503s under load.
    client = AsyncOpenAI(api_key=XAI_API_KEY, base_url=XAI_BASE_URL, timeout=8, max_retries=1)
    resp = await client.chat.completions.create(
        model=XAI_MODEL,
        messages=messages,
        max_tokens=512,  # thinking models count reasoning tokens against this; 200 truncated answers
        temperature=0.7,
        # Sent as a raw body field so the SDK doesn't validate the value against OpenAI's list.
        extra_body={"reasoning_effort": XAI_REASONING_EFFORT} if XAI_REASONING_EFFORT else None,
    )
    text = (resp.choices[0].message.content or "").strip()
    # Belt and braces: strip any markdown-ish characters that would be read aloud.
    return text.replace("**", "").replace("*", "").replace("#", "").strip()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="voice-service")


@app.get("/api/voice/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": XAI_MODEL,
        "reasoningEffort": XAI_REASONING_EFFORT or None,
        "hasKey": bool(XAI_API_KEY),
        "ttsVoice": XAI_TTS_VOICE if XAI_TTS_API_KEY else None,
    }


@app.post("/api/voice/speak")
async def speak(req: SpeakRequest) -> Response:
    """Text -> MP3 in Grok's voice. The browser falls back to speechSynthesis on any non-200."""
    text = req.text.strip()[:2000]
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    if not XAI_TTS_API_KEY:
        return JSONResponse({"error": "no xAI key for TTS"}, status_code=503)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                XAI_TTS_URL,
                headers={"Authorization": f"Bearer {XAI_TTS_API_KEY}"},
                json={
                    "text": text,
                    "voice_id": XAI_TTS_VOICE,
                    "language": "en",
                    "optimize_streaming_latency": 2,
                },
            )
        if r.status_code != 200:
            log.warning("TTS %s: %s", r.status_code, r.text[:200])
            return JSONResponse({"error": f"tts upstream {r.status_code}"}, status_code=503)
        return Response(content=r.content, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
    except Exception as e:  # noqa: BLE001
        log.warning("TTS failed: %s", e)
        return JSONResponse({"error": "tts failed"}, status_code=503)


@app.post("/api/voice/ask", response_model=AskResponse)
async def ask(req: AskRequest) -> AskResponse:
    plane = req.plane
    if plane is None and req.planeId:
        plane = find_plane(req.planeId)
        if plane is None:
            log.info("planeId %r not found in fixture", req.planeId)

    messages = build_messages(req, plane)

    if not XAI_API_KEY:
        log.warning("XAI_API_KEY not set; using fallback answer")
        return AskResponse(answer=fallback_answer(req, plane))

    try:
        answer = await ask_grok(messages)
        if not answer:
            raise RuntimeError("empty answer from model")
        return AskResponse(answer=answer)
    except Exception as e:  # noqa: BLE001
        log.exception("Grok call failed: %s", e)
        return AskResponse(answer=fallback_answer(req, plane))
