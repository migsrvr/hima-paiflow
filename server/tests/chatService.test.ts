import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatService, ChatServiceError } from '../src/services/chatService.js';

const context = {
  currency: 'PHP', allowance: 1500, frequency: 'weekly',
  universityDays: ['Mon', 'Wed', 'Fri'], safeToSpend: 420,
  spendingSoFar: 280, emergencyReserves: 200,
};

function serviceWith(fetchImpl: typeof fetch, timeoutMs = 1000, log: (line: string) => void = () => {}) {
  return new ChatService({ apiKey: 'test-key', model: 'openai/gpt-oss-120b', timeoutMs, fetchImpl, log });
}

test('logs why a reply failed, with the provider error code but never the key', async () => {
  const logs: string[] = [];
  const notFound = serviceWith(async () => Response.json(
    { error: { message: 'The model `x` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } },
    { status: 404 },
  ), 1000, (line) => logs.push(line));
  await assert.rejects(notFound.ask('Advice'), (error: unknown) => error instanceof ChatServiceError && error.code === 'AI_UNAVAILABLE');
  assert.match(logs[0], /^\[ai\] Provider answered 404 for model openai\/gpt-oss-120b: model_not_found: The model/);

  const invented = serviceWith(async () => Response.json({ choices: [{ message: { content: 'You can spend ₱999 today.' } }] }), 1000, (line) => logs.push(line));
  await assert.rejects(invented.ask('Help me plan', { safeToSpend: 420 }));
  assert.match(logs[1], /Reply rejected: .* \(999\)/);

  const ok = serviceWith(async () => Response.json({ choices: [{ message: { content: 'Keep your reserve protected.' } }] }), 1000, (line) => logs.push(line));
  await ok.ask('Advice');
  assert.match(logs[2], /^\[ai\] Answered in \d+ ms \(model openai\/gpt-oss-120b\)\.$/);
  assert.equal(logs.some((line) => line.includes('test-key')), false);
});

test('uses the specified endpoint and grounds the prompt in the full context', async () => {
  let requestBody: Record<string, any> = {};
  const service = serviceWith(async (url, init) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer test-key');
    assert.match(headers.get('User-Agent') ?? '', /Hima/);
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: 'You have ₱420 Safe-to-Spend. Keep your ₱200 emergency reserve protected.' } }] });
  });
  const reply = await service.ask('Can my budget last?', context);
  assert.equal(requestBody.model, 'openai/gpt-oss-120b');
  assert.match(requestBody.messages[0].content, /Hima AI/);
  assert.match(requestBody.messages[0].content, /Never.*invent/i);
  assert.match(requestBody.messages[1].content, /Mon/);
  assert.match(requestBody.messages[1].content, /1500/);
  assert.equal(reply.text, 'You have ₱420 Safe-to-Spend. Keep your ₱200 emergency reserve protected.');
  assert.deepEqual(reply.calculated, [
    { label: 'Allowance', value: '₱1,500.00' },
    { label: 'Safe-to-Spend', value: '₱420.00' },
    { label: 'Spending so far', value: '₱280.00' },
    { label: 'Emergency reserves', value: '₱200.00' },
  ]);
});

test('accepts structured content but ignores model-provided calculations and plan changes', async () => {
  const service = serviceWith(async () => Response.json({ choices: [{ message: { content: JSON.stringify({
    text: 'Protect your emergency reserve.',
    calculated: [{ label: 'Invented', value: '₱999.00' }],
    suggestion: { emergencyReserve: 0, autoApply: true },
  }) } }] }));
  const reply = await service.ask('Help me plan', context);
  assert.equal(reply.text, 'Protect your emergency reserve.');
  assert.ok(reply.calculated?.every((item) => item.label !== 'Invented'));
  assert.equal(reply.suggestion, undefined);
});

test('rejects invented amounts in prose, including unmarked numbers', async () => {
  for (const content of ['You can spend ₱999 today.', 'Set aside 999 for food.']) {
    const service = serviceWith(async () => Response.json({ choices: [{ message: { content } }] }));
    await assert.rejects(service.ask('Help me plan', context), (error: unknown) =>
      error instanceof ChatServiceError && error.code === 'UNVERIFIED_AI_NUMBERS');
  }
});

test('supports missing context without inventing zero-valued figures', async () => {
  const service = serviceWith(async () => Response.json({ choices: [{ message: { content: 'Please share your allowance and Safe-to-Spend.' } }] }));
  const reply = await service.ask('Can I afford lunch?');
  assert.deepEqual(reply.calculated, []);
});

test('accepts amounts supplied in the question and normalized decimal formatting', async () => {
  const service = serviceWith(async () => Response.json({ choices: [{ message: { content: '₱150.00 fits within your ₱420.00 Safe-to-Spend.' } }] }));
  assert.match((await service.ask('Can I spend ₱150?', context)).text, /150/);
});

test('handles fenced JSON replies', async () => {
  const service = serviceWith(async () => Response.json({ choices: [{ message: { content: '```json\n{"text":"Keep your reserve protected."}\n```' } }] }));
  assert.equal((await service.ask('Advice', context)).text, 'Keep your reserve protected.');
});

test('returns safe errors for rejected, malformed, and empty upstream responses', async () => {
  for (const response of [
    new Response('secret-provider-body', { status: 403 }),
    new Response('not JSON', { status: 200 }),
    Response.json({ choices: [{ message: { content: '' } }] }),
    Response.json({ choices: [] }),
  ]) {
    await assert.rejects(serviceWith(async () => response).ask('Advice', context), (error: unknown) => {
      assert.ok(error instanceof ChatServiceError);
      assert.equal(error.message.includes('secret-provider-body'), false);
      return true;
    });
  }
});

test('distinguishes upstream throttling and timeouts', async () => {
  await assert.rejects(serviceWith(async () => new Response('', { status: 429 })).ask('Advice'),
    (error: unknown) => error instanceof ChatServiceError && error.status === 503);
  await assert.rejects(serviceWith(async () => { throw new DOMException('Timed out', 'TimeoutError'); }).ask('Advice'),
    (error: unknown) => error instanceof ChatServiceError && error.status === 504);
});

test('missing credentials fail without making a network request', async () => {
  const service = new ChatService({ apiKey: '', fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(service.ask('Advice'), (error: unknown) =>
    error instanceof ChatServiceError && error.status === 503);
});
