"""Approved speech assembled from grounded answers and shared action templates."""
import json
from pathlib import Path
import re

TEMPLATES = json.loads((Path(__file__).resolve().parent.parent / 'shared' / 'voice-confirmations.json').read_text())


def approved_speech_text(answer, actions):
    confirmations = [TEMPLATES['map_' + action.mode if action.type == 'set_map_mode' else action.type]
                     for action in actions]
    controls_only = bool(actions) and all(action.type in ('set_map_mode', 'set_map_extent', 'clear_guidance')
                                          for action in actions)
    text = ' '.join(confirmations if controls_only else [answer, *confirmations]).strip()
    return re.sub(r'\b(?:hey|hay|hi|ok|okay|yo)[,\s]+(?:gemini|geminy|jemini|gem\s+in\s+eye)\b',
                  'the assistant', text, flags=re.I)
