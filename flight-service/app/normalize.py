"""readsb aircraft dict -> contract `Plane` dict."""
from .geo import bearing_deg, haversine_km

AIRLINES = {
    "AAL": "American Airlines", "ASA": "Alaska Airlines", "AAY": "Allegiant Air",
    "ACA": "Air Canada", "AFR": "Air France", "BAW": "British Airways",
    "DAL": "Delta Air Lines", "EDV": "Endeavor Air", "ENY": "Envoy Air",
    "FDX": "FedEx", "FFT": "Frontier Airlines", "JBU": "JetBlue",
    "JIA": "PSA Airlines", "KLM": "KLM", "DLH": "Lufthansa", "NKS": "Spirit Airlines",
    "RPA": "Republic Airways", "SKW": "SkyWest Airlines", "SWA": "Southwest Airlines",
    "UAL": "United Airlines", "UPS": "UPS Airlines", "GJS": "GoJet Airlines",
    "ASH": "Mesa Airlines", "PDT": "Piedmont Airlines", "KAL": "Korean Air",
    "QTR": "Qatar Airways", "UAE": "Emirates", "VIR": "Virgin Atlantic",
    "AMX": "Aeromexico", "VOI": "Volaris", "WJA": "WestJet", "SCX": "Sun Country",
    "MXY": "Breeze Airways", "GTI": "Atlas Air", "ABX": "ABX Air", "CPZ": "Compass Airlines",
}

TYPE_NAMES = {
    "A19N": "Airbus A319neo", "A20N": "Airbus A320neo", "A21N": "Airbus A321neo",
    "A318": "Airbus A318", "A319": "Airbus A319", "A320": "Airbus A320", "A321": "Airbus A321",
    "A332": "Airbus A330-200", "A333": "Airbus A330-300", "A339": "Airbus A330-900neo",
    "A359": "Airbus A350-900", "A35K": "Airbus A350-1000", "A388": "Airbus A380-800",
    "BCS1": "Airbus A220-100", "BCS3": "Airbus A220-300",
    "B712": "Boeing 717-200", "B733": "Boeing 737-300", "B737": "Boeing 737-700",
    "B738": "Boeing 737-800", "B739": "Boeing 737-900", "B37M": "Boeing 737 MAX 7",
    "B38M": "Boeing 737 MAX 8", "B39M": "Boeing 737 MAX 9", "B3XM": "Boeing 737 MAX 10",
    "B752": "Boeing 757-200", "B753": "Boeing 757-300", "B762": "Boeing 767-200",
    "B763": "Boeing 767-300", "B764": "Boeing 767-400", "B744": "Boeing 747-400",
    "B748": "Boeing 747-8", "B772": "Boeing 777-200", "B77W": "Boeing 777-300ER",
    "B77L": "Boeing 777-200LR", "B788": "Boeing 787-8", "B789": "Boeing 787-9",
    "B78X": "Boeing 787-10", "MD11": "McDonnell Douglas MD-11", "MD88": "McDonnell Douglas MD-88",
    "CRJ2": "Bombardier CRJ200", "CRJ7": "Bombardier CRJ700", "CRJ9": "Bombardier CRJ900",
    "CRJX": "Bombardier CRJ1000", "E170": "Embraer 170", "E75L": "Embraer 175",
    "E75S": "Embraer 175", "E190": "Embraer 190", "E195": "Embraer 195",
    "E290": "Embraer E190-E2", "E295": "Embraer E195-E2", "E145": "Embraer ERJ-145",
    "E135": "Embraer ERJ-135", "DH8D": "De Havilland Dash 8-400", "AT76": "ATR 72-600",
    "C172": "Cessna 172 Skyhawk", "C182": "Cessna 182 Skylane", "C152": "Cessna 152",
    "C208": "Cessna 208 Caravan", "C210": "Cessna 210 Centurion", "SR22": "Cirrus SR22",
    "SR20": "Cirrus SR20", "PA28": "Piper PA-28 Cherokee", "PA32": "Piper PA-32",
    "PA46": "Piper PA-46 Malibu", "BE20": "Beechcraft King Air 200", "BE35": "Beechcraft Bonanza",
    "BE36": "Beechcraft Bonanza", "BE58": "Beechcraft Baron", "PC12": "Pilatus PC-12",
    "C56X": "Cessna Citation Excel", "C68A": "Cessna Citation Latitude",
    "C700": "Cessna Citation Longitude", "CL30": "Bombardier Challenger 300",
    "CL35": "Bombardier Challenger 350", "CL60": "Bombardier Challenger 600",
    "GLF4": "Gulfstream IV", "GLF5": "Gulfstream V", "GLF6": "Gulfstream G650",
    "GL5T": "Bombardier Global 5000", "GLEX": "Bombardier Global Express",
    "E55P": "Embraer Phenom 300", "E50P": "Embraer Phenom 100", "LJ45": "Learjet 45",
    "H25B": "Hawker 800", "FA7X": "Dassault Falcon 7X", "F900": "Dassault Falcon 900",
    "EC35": "Airbus H135", "EC45": "Airbus H145", "AS50": "Airbus AS350 Ecureuil",
    "R44": "Robinson R44", "R22": "Robinson R22", "B06": "Bell 206", "B407": "Bell 407",
    "C130": "Lockheed C-130 Hercules", "C17": "Boeing C-17 Globemaster III",
}


# ICAO type designators for helicopters, for aircraft that don't broadcast category A7.
HELICOPTER_TYPES = {
    "EC20", "EC30", "EC35", "EC45", "EC55", "EC75", "H160", "H175", "BK17",
    "AS32", "AS50", "AS55", "AS65", "A109", "A119", "A139", "A169", "A189",
    "B06", "B06T", "B407", "B412", "B429", "B505", "UH1", "H60", "H47", "H64",
    "S76", "S92", "R22", "R44", "R66", "H500", "MD52", "MD60", "EN28", "EN48",
}


def _kind(category: str | None, type_code: str | None) -> str:
    """'helicopter' if the ADS-B emitter category is A7 (rotorcraft) or the type is a known helicopter."""
    if category == "A7" or (type_code and type_code in HELICOPTER_TYPES):
        return "helicopter"
    return "plane"


# readsb `emergency` values that mean a real emergency. "lifeguard" is a medical-priority flight,
# not an emergency, so it's reported as medical instead.
EMERGENCY_STATUSES = {"general", "minfuel", "nordo", "unlawful", "downed"}
# Emergency squawk codes, used when the emergency field isn't set.
EMERGENCY_SQUAWKS = {"7500": "unlawful", "7600": "nordo", "7700": "general"}
# Air-ambulance callsign prefixes (there's no reliable "medical" flag in ADS-B besides lifeguard).
MEDICAL_CALLSIGN_PREFIXES = (
    "GRDIAN", "LIFE", "MEDIC", "MEDEVAC", "EVAC", "ANGEL", "AIRMED", "CAREFLT", "MERCY", "MEDSTAR",
)
# adsb.lol dbFlags bit for military aircraft.
DBFLAG_MILITARY = 1


def _emergency(ac: dict) -> str | None:
    status = (ac.get("emergency") or "").strip().lower()
    if status in EMERGENCY_STATUSES:
        return status
    return EMERGENCY_SQUAWKS.get(str(ac.get("squawk") or "").strip())


def _medical(ac: dict, callsign: str | None) -> bool:
    if (ac.get("emergency") or "").strip().lower() == "lifeguard":
        return True
    return bool(callsign) and callsign.upper().startswith(MEDICAL_CALLSIGN_PREFIXES)


def _military(ac: dict) -> bool:
    flags = ac.get("dbFlags")
    return isinstance(flags, int) and bool(flags & DBFLAG_MILITARY)


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def normalize(ac: dict, center_lat: float, center_lon: float) -> dict | None:
    lat, lon = _num(ac.get("lat")), _num(ac.get("lon"))
    if lat is None or lon is None:
        return None

    callsign = (ac.get("flight") or "").strip() or None
    type_code = (ac.get("t") or "").strip().upper() or None
    category = (ac.get("category") or "").strip().upper() or None
    alt = ac.get("alt_baro")
    altitude_ft = 0.0 if alt == "ground" else _num(alt)
    # ft/min, + = climbing. baro_rate is the common one; geom_rate (GPS) as fallback.
    vertical_rate = _num(ac.get("baro_rate"))
    if vertical_rate is None:
        vertical_rate = _num(ac.get("geom_rate"))

    airline = None
    if callsign and len(callsign) > 3 and callsign[:3].isalpha() and callsign[3].isdigit():
        airline = AIRLINES.get(callsign[:3].upper())

    return {
        "id": (ac.get("hex") or "").lstrip("~").lower(),
        "callsign": callsign,
        "registration": (ac.get("r") or "").strip() or None,
        "typeCode": type_code,
        "typeName": TYPE_NAMES.get(type_code) if type_code else None,
        "category": category,
        "kind": _kind(category, type_code),
        "onGround": alt == "ground",
        "emergency": _emergency(ac),
        "military": _military(ac),
        "medical": _medical(ac, callsign),
        "airline": airline,
        "origin": None,
        "destination": None,
        "lat": lat,
        "lon": lon,
        "altitudeFt": altitude_ft,
        "groundSpeedKt": _num(ac.get("gs")),
        "trackDeg": _num(ac.get("track")),
        "verticalRateFpm": vertical_rate,
        "distanceKm": round(haversine_km(center_lat, center_lon, lat, lon), 3),
        "bearingDeg": round(bearing_deg(center_lat, center_lon, lat, lon), 2),
    }
