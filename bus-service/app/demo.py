"""Synthetic vehicles on captured RTS geometry. Never used as a live fallback."""
import json
from .network import FIXTURE


def buses():
    patterns = json.loads(FIXTURE.read_text())['patterns']
    result = []
    for i in range(10):
        pattern = patterns[i % len(patterns)]
        # Deliberately distribute vehicles around campus, with missing-data examples.
        point = pattern['shape'][min(len(pattern['shape']) - 1, (i * 13 + 4) % max(1, len(pattern['shape']) // 2))]
        result.append(dict(id=f'demo-{i+1}', route=pattern['routeId'],
            patternId=pattern['patternId'], destination=pattern['stops'][-1]['name'] if i != 7 else None,
            **point, headingDeg=None, speedMph=12 if i % 3 else None,
            delayed=True if i == 3 else None if i == 7 else False,
            passengerLoad='FULL' if i == 2 else 'HALF_EMPTY' if i % 2 else 'EMPTY'))
    return result
