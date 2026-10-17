import { validJourney, validOverlay, validPlan } from '../journey-state';
import type { TransitAction, TransitContext, TransitReply } from '../../../shared/assistant';

/** Reject an entire response before applying any actions, including unknown actions. */
export function parseTransitReply(value: unknown, requestId: string): TransitReply {
  const reply = value as TransitReply | null;
  if (!reply || reply.requestId !== requestId || typeof reply.answer !== 'string' || !reply.answer.trim() || reply.answer.length > 2000 ||
      !['gemini', 'local', 'scripted'].includes(reply.source) || !Array.isArray(reply.actions) || reply.actions.length > 8 ||
      !(reply.focusedBusId === null || typeof reply.focusedBusId === 'string')) throw new Error('Invalid assistant response');
  for (const action of reply.actions) {
    if (!action || typeof action !== 'object') throw new Error('Invalid assistant action');
    if (action.type === 'set_map_mode' && ['compact', 'expanded'].includes(action.mode) && Object.keys(action).length === 2) continue;
    if (action.type === 'set_map_extent' && typeof action.extentKm === 'number' && Number.isFinite(action.extentKm) && action.extentKm >= 0.1 && action.extentKm <= 400 && Object.keys(action).length === 2) continue;
    if (action.type === 'show_journeys' && validPlan(action.plan) && Object.keys(action).length === 2) continue;
    if (action.type === 'show_routes' && Array.isArray(action.routes) && action.routes.length > 0 && action.routes.length <= 6 && action.routes.every(validOverlay) && Object.keys(action).length === 2) continue;
    if (action.type === 'start_guidance' && validJourney(action.journey) && Object.keys(action).length === 2) continue;
    if (action.type === 'clear_guidance' && Object.keys(action).length === 1) continue;
    throw new Error('Unsupported assistant action');
  }
  return reply;
}

export function createTransitConversation(getContext: () => TransitContext, apply: (actions: TransitAction[]) => string, onReply?: (reply: TransitReply) => void) {
  let generation = 0;
  let previousBusId: string | null = null;
  let history: { question: string; answer: string }[] = [];
  let snapshot: TransitContext | null = null;
  return {
    capture() { snapshot = structuredClone(getContext()); },
    reset() { generation++; previousBusId = null; history = []; snapshot = null; },
    async ask(question: string, signal: AbortSignal, image?: { mimeType: 'image/jpeg'; data: string }): Promise<string> {
      const current = ++generation;
      const requestId = crypto.randomUUID();
      const context = snapshot ?? getContext();
      snapshot = null;
      const res = await fetch('/api/voice/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ requestId, question, ...(image ? { image } : {}), context: { ...context, previousBusId }, history }),
      });
      if (!res.ok) throw new Error(`Assistant service returned ${res.status}`);
      const reply = parseTransitReply(await res.json(), requestId);
      if (signal.aborted || current !== generation) throw new Error('Discarded stale assistant response');
      // Text describes the change actually applied locally, not a model's promise.
      const applied = apply(reply.actions);
      onReply?.(reply);
      const onlyMap = reply.actions.every(a => a.type === 'set_map_mode' || a.type === 'set_map_extent');
      const result = reply.actions.length ? (reply.source === 'gemini' && !onlyMap ? `${reply.answer} ${applied}` : applied) : reply.answer;
      const answer = reply.source === 'scripted' ? `Scripted demo. ${result}` : reply.source === 'local' && reply.actions.length ? `Local transit tools. ${result}` : result;
      previousBusId = reply.focusedBusId ?? previousBusId;
      history = [...history, { question, answer: answer.slice(0, 2000) }].slice(-4);
      return answer;
    },
  };
}
