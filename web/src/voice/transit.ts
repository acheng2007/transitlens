import type { TransitAction, TransitContext, TransitReply } from '../../../shared/assistant';

/** Reject an entire response before applying any actions, including unknown actions. */
export function parseTransitReply(value: unknown, requestId: string): TransitReply {
  const reply = value as TransitReply | null;
  if (!reply || reply.requestId !== requestId || typeof reply.answer !== 'string' || !reply.answer.trim() || reply.answer.length > 2000 ||
      !['gemini', 'local'].includes(reply.source) || !Array.isArray(reply.actions) || reply.actions.length > 8 ||
      !(reply.focusedBusId === null || typeof reply.focusedBusId === 'string')) throw new Error('Invalid assistant response');
  for (const action of reply.actions) {
    if (!action || typeof action !== 'object') throw new Error('Invalid assistant action');
    if (action.type === 'set_map_mode' && ['compact', 'expanded'].includes(action.mode) && Object.keys(action).length === 2) continue;
    if (action.type === 'set_map_extent' && typeof action.extentKm === 'number' && Number.isFinite(action.extentKm) && action.extentKm >= 0.1 && action.extentKm <= 400 && Object.keys(action).length === 2) continue;
    throw new Error('Unsupported assistant action');
  }
  return reply;
}

export function createTransitConversation(getContext: () => TransitContext, apply: (actions: TransitAction[]) => string) {
  let generation = 0;
  let previousBusId: string | null = null;
  let history: { question: string; answer: string }[] = [];
  let snapshot: TransitContext | null = null;
  return {
    capture() { snapshot = structuredClone(getContext()); },
    reset() { generation++; previousBusId = null; history = []; snapshot = null; },
    async ask(question: string, signal: AbortSignal): Promise<string> {
      const current = ++generation;
      const requestId = crypto.randomUUID();
      const context = snapshot ?? getContext();
      snapshot = null;
      const res = await fetch('/api/voice/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ requestId, question, context: { ...context, previousBusId }, history }),
      });
      if (!res.ok) throw new Error(`Assistant service returned ${res.status}`);
      const reply = parseTransitReply(await res.json(), requestId);
      if (signal.aborted || current !== generation) throw new Error('Discarded stale assistant response');
      // Text describes the change actually applied locally, not a model's promise.
      const applied = apply(reply.actions);
      const answer = reply.actions.length ? applied : reply.answer;
      previousBusId = reply.focusedBusId ?? previousBusId;
      history = [...history, { question, answer }].slice(-4);
      return answer;
    },
  };
}
