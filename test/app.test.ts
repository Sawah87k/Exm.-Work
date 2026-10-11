import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { MockCrmClient } from '../src/crm.ts';
import { LeadService } from '../src/service.ts';
import { createApp } from '../src/app.ts';

async function start(opts = {}) {
  const crm = new MockCrmClient();
  const service = new LeadService(openDb(':memory:'), crm);
  const server = createApp(service, opts);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { crm, service, base, close: () => server.close() };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('POST /api/lead: успешная заявка, ошибка валидации, бот', async () => {
  const { base, service, close } = await start();
  try {
    const ok = await post(`${base}/api/lead`, { name: 'Анна', phone: '9001112233' });
    assert.equal(ok.status, 201);
    assert.equal(((await ok.json()) as { ok: boolean }).ok, true);

    const bad = await post(`${base}/api/lead`, { name: 'Анна' });
    assert.equal(bad.status, 400);

    const bot = await post(`${base}/api/lead`, { name: 'Бот', phone: '9001112244', website: 'x' });
    assert.equal(bot.status, 201);
    assert.equal(service.stats().total, 1); // бот ничего не сохранил

    const broken = await fetch(`${base}/api/lead`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(broken.status, 400);
  } finally {
    close();
  }
});

test('страница менеджеров защищена паролем и экранирует HTML', async () => {
  const { base, close } = await start({ adminPassword: 'секрет' });
  try {
    await post(`${base}/api/lead`, { name: '<script>alert(1)</script>', phone: '9001112233' });
    assert.equal((await fetch(`${base}/`)).status, 401);
    const auth = 'Basic ' + Buffer.from('admin:секрет').toString('base64');
    const page = await fetch(`${base}/`, { headers: { Authorization: auth } });
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.ok(!text.includes('<script>alert(1)'));
    assert.ok(text.includes('&#60;script&#62;'));
  } finally {
    close();
  }
});

test('ограничение частоты: лишние заявки получают 429', async () => {
  const { base, close } = await start({ rateLimitPerMinute: 2 });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await post(`${base}/api/lead`, { name: 'Анна', phone: `90011122${30 + i}` })).status);
    assert.deepEqual(codes, [201, 201, 429]);
  } finally {
    close();
  }
});
