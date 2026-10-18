import { validJourney, validOverlay, validPlan, validBusStopResult, validBusChoice } from '../journey-state';
import type { SpeechResult } from './types';
import type { Clarification, TransitAction, TransitContext, TransitReply } from '../../../shared/assistant';
import { approvedSpeechText } from '../../../shared/voice-speech';

function validClarification(value: unknown): value is Clarification {
  if (!value || typeof value !== 'object') return false;
  const c = value as Clarification;
  return Object.keys(c).length === 4 && typeof c.id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c.id) &&
    typeof c.prompt === 'string' && c.prompt.trim().length > 0 && c.prompt.length <= 2000 &&
    ['route', 'stop', 'destination', 'vehicle', 'choice'].includes(c.expected) &&
    typeof c.expiresAt === 'string' && Number.isFinite(Date.parse(c.expiresAt));
}

/** Reject an entire response before applying any actions, including unknown actions. */
export function parseTransitReply(value: unknown, requestId: string): TransitReply {
  const reply = value as TransitReply | null;
  if (!reply || !(reply.clarification == null || validClarification(reply.clarification)) || reply.requestId !== requestId || typeof reply.answer !== 'string' || !reply.answer.trim() || reply.answer.length > 2000 ||
      !['gemini', 'local', 'scripted'].includes(reply.source) || !Array.isArray(reply.actions) || reply.actions.length > 8 ||
      !(reply.speechId == null || typeof reply.speechId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(reply.speechId)) ||
      !(reply.speechText == null || typeof reply.speechText === 'string' && reply.speechText.length > 0 && reply.speechText.length <= 4000) ||
      !(reply.focusedBusId === null || typeof reply.focusedBusId === 'string')) throw new Error('Invalid assistant response');
  for (const action of reply.actions) {
    if (!action || typeof action !== 'object') throw new Error('Invalid assistant action');
    if (action.type === 'set_map_mode' && ['compact', 'expanded'].includes(action.mode) && Object.keys(action).length === 2) continue;
    if (action.type === 'set_map_extent' && typeof action.extentKm === 'number' && Number.isFinite(action.extentKm) && action.extentKm >= 0.1 && action.extentKm <= 400 && Object.keys(action).length === 2) continue;
    if (action.type === 'show_journeys' && validPlan(action.plan) && Object.keys(action).length === 2) continue;
    if (action.type === 'show_routes' && Array.isArray(action.routes) && action.routes.length > 0 && action.routes.length <= 6 && action.routes.every(validOverlay) && Object.keys(action).length === 2) continue;
    if (action.type === 'start_guidance' && validJourney(action.journey) && Object.keys(action).length === 2) continue;
    if (action.type === 'clear_guidance' && Object.keys(action).length === 1) continue;
    if (action.type === 'show_bus_stop' && Object.keys(action).length === 2 && validBusStopResult(action.result)) continue;
    if (action.type === 'show_bus_choices' && Object.keys(action).length === 2 && Array.isArray(action.buses) && action.buses.length > 0 && action.buses.length <= 6 && action.buses.every(validBusChoice)) continue;
    if (action.type === 'set_onboard_bus' && Object.keys(action).length === 2 && (action.bus === null || validBusChoice(action.bus))) continue;
    throw new Error('Unsupported assistant action');
  }
  return reply;
}

export function createTransitConversation(getContext: () => TransitContext, apply: (actions: TransitAction[]) => string, onReply?: (reply: TransitReply) => void) {
  let generation = 0;
  let previousBusId: string | null = null;
  let history: { question: string; answer: string }[] = [];
  let snapshot: TransitContext | null = null;
  let sessionId = crypto.randomUUID();
  let clarification: Clarification | null = null;
  let dataMode: 'live' | 'demo' | undefined;
  function reset() {
    generation++; sessionId = crypto.randomUUID(); previousBusId = null; history = []; snapshot = null;
    clarification = null; dataMode = undefined;
  }
  async function askSpeech(question: string, signal: AbortSignal, image?: { mimeType: 'image/jpeg'; data: string }): Promise<SpeechResult> {
    const fresh = getContext();
    const mode = fresh.dataMode ?? 'live';
    if (dataMode !== undefined && dataMode !== mode) reset();
    dataMode = mode;
    const current = ++generation;
    const requestId = crypto.randomUUID();
    const context = snapshot && (snapshot.dataMode ?? 'live') === mode ? snapshot : fresh;
    snapshot = null;
    const res = await fetch('/api/voice/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ requestId, question, ...(image ? { image } : {}), context: { ...context, previousBusId, sessionId, clarificationId: clarification?.id ?? null }, history }),
    });
    if (!res.ok) throw new Error(`Assistant service returned ${res.status}`);
    const reply = parseTransitReply(await res.json(), requestId);
    if (signal.aborted || current !== generation || (getContext().dataMode ?? 'live') !== mode) throw new Error('Discarded stale assistant response');
    // Text describes the change actually applied locally, not a model's promise.
    const applied = apply(reply.actions);
    onReply?.(reply);
    const onlyMap = reply.actions.every(a => a.type === 'set_map_mode' || a.type === 'set_map_extent');
    const onlyConfirmation = onlyMap || reply.actions.every(a => a.type === 'clear_guidance');
    const result = reply.actions.length ? (onlyConfirmation ? applied : `${reply.answer} ${applied}`) : reply.answer;
    const answer = reply.source === 'scripted' ? `Scripted demo. ${result}` : reply.source === 'local' && reply.actions.length ? `Local transit tools. ${result}` : result;
    clarification = reply.clarification ?? null;
    previousBusId = reply.focusedBusId ?? previousBusId;
    history = [...history, { question, answer: answer.slice(0, 2000) }].slice(-2);
    const expectedSpeech = approvedSpeechText(reply.answer, reply.actions);
    // Old services can still supply answer-only audio for replies without actions.
    const speechMatches = reply.speechText === expectedSpeech ||
      reply.speechText == null && reply.actions.length === 0 && expectedSpeech === reply.answer;
    return { answer, speechText: expectedSpeech,
      ...(reply.speechId && speechMatches ? { speechId: reply.speechId } : {}) };
  }
  return {
    capture() { snapshot = structuredClone(getContext()); },
    reset,
    getClarification: () => clarification ? { ...clarification } : null,
    askSpeech,
    async ask(question: string, signal: AbortSignal, image?: { mimeType: 'image/jpeg'; data: string }): Promise<string> {
      return (await askSpeech(question, signal, image)).answer;
    },
  };
}
