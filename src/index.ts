import { openDb } from './db.ts';
import { BitrixClient, MockCrmClient, type CrmClient } from './crm.ts';
import { LeadService } from './service.ts';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const webhook = process.env.BITRIX_WEBHOOK_URL;
const crm: CrmClient = webhook
  ? new BitrixClient(webhook)
  : new MockCrmClient(Number(process.env.MOCK_FAIL_RATE ?? 0));
console.log(webhook ? 'CRM: Битрикс24 (вебхук)' : 'CRM: тестовая, в памяти (BITRIX_WEBHOOK_URL не задан)');

const service = new LeadService(openDb(), crm);
const server = createApp(service, {
  adminPassword: process.env.ADMIN_PASSWORD || undefined,
  allowedOrigin: process.env.ALLOWED_ORIGIN || undefined,
});

server.listen(port, host, () => console.log(`Сервер запущен: http://${host}:${port}`));

// Раз в 30 секунд повторяем отправку заявок, которые не прошли
const timer = setInterval(() => {
  service.retryDue().catch((e) => console.error('Ошибка повторной отправки:', e));
}, 30_000);

process.on('SIGINT', () => {
  clearInterval(timer);
  server.close(() => process.exit(0));
});
