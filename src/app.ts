import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { LeadService } from './service.ts';
import { validateLead } from './validate.ts';
import { renderDashboard, renderDemo } from './ui.ts';

export type AppOptions = {
  /** Если задан, страница менеджеров защищена паролем (логин: admin). */
  adminPassword?: string;
  /** Сайт, которому разрешено слать заявки из браузера. */
  allowedOrigin?: string;
  /** Не более стольких заявок с одного адреса в минуту. */
  rateLimitPerMinute?: number;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest();

async function readBody(req: http.IncomingMessage, limit = 20_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readFields(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
    } catch {
      /* упадём ниже с понятной ошибкой */
    }
    throw new HttpError(400, 'Тело запроса должно быть JSON-объектом');
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export function createApp(service: LeadService, opts: AppOptions = {}): http.Server {
  const hits = new Map<string, number[]>();
  const limit = opts.rateLimitPerMinute ?? 10;

  const tooMany = (ip: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > limit;
  };

  const authorized = (req: http.IncomingMessage): boolean => {
    if (!opts.adminPassword) return true;
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) return false;
    const [, pass = ''] = Buffer.from(header.slice(6), 'base64').toString().split(/:(.*)/s);
    return timingSafeEqual(sha(pass), sha(opts.adminPassword));
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const html = (res: http.ServerResponse, body: string) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (opts.allowedOrigin && path === '/api/lead') {
      res.setHeader('Access-Control-Allow-Origin', opts.allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Приём заявки с сайта
    if (req.method === 'POST' && path === '/api/lead') {
      if (tooMany(req.socket.remoteAddress ?? 'unknown')) {
        return json(res, 429, { ok: false, errors: { _: 'Слишком много заявок, попробуйте через минуту' } });
      }
      const result = validateLead(await readFields(req));
      if (result.kind === 'spam') return json(res, 201, { ok: true }); // боту не сообщаем, что он пойман
      if (result.kind === 'invalid') return json(res, 400, { ok: false, errors: result.errors });

      const { id, duplicate } = service.accept(result.lead);
      // Отвечаем сайту сразу, а в CRM отправляем в фоне: медленная CRM не должна ломать форму.
      void service.sync(id);
      return json(res, 201, { ok: true, id, duplicate });
    }

    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });

    // Всё ниже — для менеджеров
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Leads", charset="UTF-8"' });
      return res.end('Нужен пароль');
    }
    if (req.method === 'GET' && path === '/') {
      return html(res, renderDashboard(service.listLeads(), service.recentLogs(), service.stats()));
    }
    if (req.method === 'GET' && path === '/demo') return html(res, renderDemo());

    if (req.method === 'POST' && path === '/retry') {
      // Защита от CSRF: Basic-авторизацию браузер подставляет сам, поэтому проверяем Origin.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Запрещено');
      const id = Number((await readFields(req)).id);
      if (!Number.isInteger(id)) throw new HttpError(400, 'Некорректный номер заявки');
      void service.retryNow(id);
      res.writeHead(303, { Location: '/' });
      return res.end();
    }

    throw new HttpError(404, 'Не найдено');
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, status, { ok: false, errors: { _: status === 500 ? 'Внутренняя ошибка' : e.message } });
      else res.end();
    });
  });
}
