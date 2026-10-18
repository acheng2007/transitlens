import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitConversation, parseTransitReply } from '../src/voice/transit';
import type { Clarification, TransitContext } from '../../shared/assistant';

const pending: Clarification = { id: 'a'.repeat(43), prompt: 'Which route?', expected: 'route', expiresAt: '2099-01-01T00:00:00Z' };
const context: TransitContext = { dataMode: 'demo', focusedBusId: null, position: null, radiusKm: 5, map: { mode: 'compact', extentKm: 5 } };
const reply = { answer: 'Which route?', source: 'local', focusedBusId: null, actions: [], clarification: pending };
const signal = () => new AbortController().signal;

test('clarification metadata is strictly validated before actions apply', () => {
  for (const bad of [{ ...pending, id: 'bad' }, { ...pending, prompt: '' }, { ...pending, expected: 'script' },
    { ...pending, expiresAt: 'tomorrow' }, { ...pending, extra: 'unsupported' }]) {
    assert.throws(() => parseTransitReply({ ...reply, requestId: 'r', clarification: bad }, 'r'));
  }
  assert.deepEqual(parseTransitReply({ ...reply, requestId: 'r' }, 'r').clarification, pending);
  assert.ok(parseTransitReply({ ...reply, requestId: 'r', clarification: undefined }, 'r'));
});

test('typed and spoken adapters carry server state through map interludes and clear on completion or reset', async () => {
  const saved = globalThis.fetch;
  const requests: any[] = [];
  let respond: any = { ...reply };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body)); requests.push(body);
    return Response.json({ ...respond, requestId: body.requestId });
  };
  try {
    const conversation = createTransitConversation(() => context, () => 'Map updated.');
    await conversation.ask('When does the bus arrive?', signal());
    assert.equal(requests[0].context.clarificationId, null);
    assert.equal(conversation.getClarification()?.id, pending.id);
    respond = { ...reply, actions: [{ type: 'set_map_mode', mode: 'expanded' }] };
    conversation.capture();
    await conversation.askSpeech('expand the map', signal());
    assert.equal(requests[1].context.clarificationId, pending.id);
    respond = { ...reply, clarification: null };
    await conversation.ask('38', signal());
    assert.equal(requests[2].context.clarificationId, pending.id);
    assert.equal(conversation.getClarification(), null);
    respond = reply;
    await conversation.ask('another question', signal());
    const oldSession = requests.at(-1).context.sessionId;
    conversation.reset();
    await conversation.ask('new question', signal());
    assert.equal(requests.at(-1).context.clarificationId, null);
    assert.notEqual(requests.at(-1).context.sessionId, oldSession);
  } finally { globalThis.fetch = saved; }
});

test('failed requests or action application cannot replace clarification state', async () => {
  const saved = globalThis.fetch;
  let mode: 'pending' | 'http' | 'apply' = 'pending';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    return mode === 'http' ? new Response(null, { status: 503 }) : Response.json({ ...reply,
      requestId: body.requestId, clarification: mode === 'apply' ? null : pending });
  };
  try {
    const conversation = createTransitConversation(() => context, () => { if (mode === 'apply') throw new Error('Failed action'); return ''; });
    await conversation.ask('first', signal());
    mode = 'http'; await assert.rejects(conversation.ask('38', signal()));
    assert.equal(conversation.getClarification()?.id, pending.id);
    mode = 'apply'; await assert.rejects(conversation.ask('38', signal()));
    assert.equal(conversation.getClarification()?.id, pending.id);
  } finally { globalThis.fetch = saved; }
});

test('late and aborted replies cannot install or erase a newer clarification', async () => {
  const saved = globalThis.fetch;
  const complete: Array<(metadata: Clarification | null) => void> = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    return new Promise<Response>(resolve => complete.push(clarification => resolve(Response.json({ ...reply, requestId: body.requestId, clarification }))));
  };
  try {
    const conversation = createTransitConversation(() => context, () => '');
    const first = conversation.ask('old', signal());
    const rejected = assert.rejects(first, /stale/);
    const second = conversation.ask('new', signal());
    complete[1](pending); await second;
    complete[0](null); await rejected;
    assert.equal(conversation.getClarification()?.id, pending.id);
    const controller = new AbortController();
    const canceled = conversation.ask('canceled', controller.signal);
    const cancellation = assert.rejects(canceled, /stale/);
    controller.abort(); complete[2](null); await cancellation;
    assert.equal(conversation.getClarification()?.id, pending.id);
  } finally { globalThis.fetch = saved; }
});

test('mode switches start a fresh session and reject in-flight responses from the old mode', async () => {
  const saved = globalThis.fetch;
  let mode: 'live' | 'demo' = 'demo';
  const requests: any[] = [];
  let finish: (() => void) | undefined;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body)); requests.push(body);
    if (body.question === 'slow') await new Promise<void>(resolve => { finish = resolve; });
    return Response.json({ ...reply, requestId: body.requestId });
  };
  try {
    const conversation = createTransitConversation(() => ({ ...context, dataMode: mode }), () => '');
    await conversation.ask('first', signal());
    const oldSession = requests[0].context.sessionId;
    const slow = conversation.ask('slow', signal());
    const rejected = assert.rejects(slow, /stale/);
    mode = 'live'; finish!(); await rejected;
    await conversation.ask('fresh', signal());
    assert.equal(requests.at(-1).context.clarificationId, null);
    assert.equal(requests.at(-1).history.length, 0);
    assert.notEqual(requests.at(-1).context.sessionId, oldSession);
  } finally { globalThis.fetch = saved; }
});
