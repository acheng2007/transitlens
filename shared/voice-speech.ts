import templates from './voice-confirmations.json';
import type { TransitAction } from './assistant';

/** Identical approved templates are loaded by the server and client. */
export function approvedSpeechText(answer: string, actions: TransitAction[]): string {
  const confirmations = actions.map(action => templates[action.type === 'set_map_mode'
    ? action.mode === 'expanded' ? 'map_expanded' : 'map_compact' : action.type]);
  const controlsOnly = actions.length > 0 && actions.every(action =>
    action.type === 'set_map_mode' || action.type === 'set_map_extent' || action.type === 'clear_guidance');
  const text = (controlsOnly ? confirmations.join(' ') : [answer, ...confirmations].join(' ')).trim();
  // Never teach the phone to activate itself while reading an answer.
  return text.replace(/\b(?:hey|hay|hi|ok|okay|yo)[,\s]+(?:gemini|geminy|jemini|gem\s+in\s+eye)\b/gi, 'the assistant');
}
