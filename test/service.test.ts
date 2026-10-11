import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { MockCrmClient } from '../src/crm.ts';
import { LeadService, MAX_ATTEMPTS, backoffSeconds } from '../src/service.ts';
import { normalizePhone, validateLead } from '../src/validate.ts';

function setup() {
  const crm = new MockCrmClient();
  const clock = { t: 1_000_000 };
  const service = new LeadService(openDb(':memory:'), crm, () => clock.t);
  return { crm, clock, service };
}

const lead = (over: Record<string, unknown> = {}) => {
  const r = validateLead({ name: 'Иван', phone: '8 (900) 123-45-67', message: 'Хочу оклейку', ...over });
  assert.equal(r.kind, 'ok');
  return r.kind === 'ok' ? r.lead : (undefined as never);
};

test('телефон приводится к единому виду', () => {
  assert.equal(normalizePhone('8 (900) 123-45-67'), '+79001234567');
  assert.equal(normalizePhone('+7 900 123 45 67'), '+79001234567');
  assert.equal(normalizePhone('9001234567'), '+79001234567');
  assert.equal(normalizePhone('12345'), null);
});

test('валидация: нужен телефон или почта, ловушка для ботов', () => {
  assert.equal(validateLead({ name: 'Иван' }).kind, 'invalid');
  assert.equal(validateLead({ name: 'И', phone: '9001234567' }).kind, 'invalid');
  assert.equal(validateLead({ name: 'Иван', email: 'не-почта' }).kind, 'invalid');
  assert.equal(validateLead({ name: 'Иван', phone: '9001234567', website: 'spam.ru' }).kind, 'spam');
});

test('новая заявка уходит в CRM', async () => {
  const { crm, service } = setup();
  const { id, duplicate } = service.accept(lead());
  assert.equal(duplicate, false);
  await service.sync(id);
  const row = service.getLead(id)!;
  assert.equal(row.status, 'sent');
  assert.equal(row.crm_id, '1');
  assert.equal(crm.calls.create, 1);
});

test('дубль по телефону в другом формате не создаёт второй лид, а обновляет прежний', async () => {
  const { crm, service } = setup();
  const first = service.accept(lead());
  await service.sync(first.id);

  const second = service.accept(lead({ phone: '+7 900 123 45 67', message: 'И ещё вопрос по цене' }));
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  await service.sync(second.id);

  assert.equal(crm.calls.create, 1);
  assert.equal(crm.calls.update, 1);
  assert.equal(crm.leads.size, 1);
  assert.match(crm.leads.get('1')!.message, /Хочу оклейку[\s\S]*И ещё вопрос/);
  assert.equal(service.getLead(first.id)!.duplicates, 1);
});

test('дубль по почте находится, даже если телефон другой', () => {
  const { service } = setup();
  const a = service.accept(lead({ phone: '', email: 'Ivan@Mail.ru' }));
  const b = service.accept(lead({ phone: '9005553535', email: 'ivan@mail.ru' }));
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
});

test('при сбое CRM заявка остаётся в очереди с паузой, потом уходит', async () => {
  const { crm, clock, service } = setup();
  crm.failNext = 1;
  const { id } = service.accept(lead());
  await service.sync(id);

  let row = service.getLead(id)!;
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error ?? '', /недоступен/);
  assert.equal(row.next_retry_at, clock.t + backoffSeconds(1));

  assert.equal(await service.retryDue(), 0); // время ещё не пришло
  clock.t += 61;
  assert.equal(await service.retryDue(), 1);
  row = service.getLead(id)!;
  assert.equal(row.status, 'sent');
  assert.equal(row.last_error, null);
});

test(`после ${MAX_ATTEMPTS} неудач заявка получает статус «failed», ручной повтор её возвращает`, async () => {
  const { crm, clock, service } = setup();
  crm.failNext = MAX_ATTEMPTS;
  const { id } = service.accept(lead());
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    clock.t += 3600;
    await service.retryDue();
    await service.sync(id);
  }
  assert.equal(service.getLead(id)!.status, 'failed');
  assert.equal(await service.retryDue(), 0); // сами больше не пытаемся

  await service.retryNow(id);
  assert.equal(service.getLead(id)!.status, 'sent');
});

test('две одновременные отправки одной заявки не создают два лида в CRM', async () => {
  const { crm, service } = setup();
  const { id } = service.accept(lead());
  await Promise.all([service.sync(id), service.sync(id)]);
  assert.equal(crm.calls.create, 1);
});

test('пауза между попытками растёт, но не больше часа', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10].map(backoffSeconds), [60, 120, 240, 480, 960, 3600]);
});
