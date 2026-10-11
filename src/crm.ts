export type LeadPayload = {
  name: string;
  phone: string | null;
  email: string | null;
  message: string;
};

/** Всё, что нужно сервису от CRM. Благодаря интерфейсу CRM легко заменить или подменить в тестах. */
export interface CrmClient {
  createLead(lead: LeadPayload): Promise<string>;
  updateLead(crmId: string, lead: LeadPayload): Promise<void>;
}

/** Клиент Битрикс24 через входящий вебхук (REST API). */
export class BitrixClient implements CrmClient {
  private readonly base: string;

  constructor(webhookUrl: string, private readonly timeoutMs = 10_000) {
    this.base = webhookUrl.endsWith('/') ? webhookUrl : webhookUrl + '/';
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Битрикс24 может вернуть ошибку и с кодом 200, и с кодом 4xx. Проверяем оба случая.
    let data: { result?: unknown; error?: string; error_description?: string } = {};
    try {
      data = await res.json();
    } catch {
      /* тело не JSON, разберёмся ниже по статусу */
    }
    if (data.error) throw new Error(`Битрикс24: ${data.error} ${data.error_description ?? ''}`.trim());
    if (!res.ok) throw new Error(`Битрикс24: HTTP ${res.status}`);
    return data.result;
  }

  async createLead(lead: LeadPayload): Promise<string> {
    const result = await this.call('crm.lead.add', {
      fields: {
        TITLE: `Заявка с сайта: ${lead.name}`,
        NAME: lead.name,
        COMMENTS: lead.message,
        SOURCE_ID: 'WEB',
        ...(lead.phone && { PHONE: [{ VALUE: lead.phone, VALUE_TYPE: 'WORK' }] }),
        ...(lead.email && { EMAIL: [{ VALUE: lead.email, VALUE_TYPE: 'WORK' }] }),
      },
      params: { REGISTER_SONET_EVENT: 'Y' },
    });
    if (result === undefined || result === null) throw new Error('Битрикс24 не вернул id лида');
    return String(result);
  }

  async updateLead(crmId: string, lead: LeadPayload): Promise<void> {
    await this.call('crm.lead.update', { id: crmId, fields: { COMMENTS: lead.message } });
  }
}

/** Тестовая CRM в памяти. Позволяет запускать проект без реального Битрикс24 и имитировать сбои. */
export class MockCrmClient implements CrmClient {
  readonly leads = new Map<string, LeadPayload>();
  readonly calls = { create: 0, update: 0 };
  /** Сколько ближайших запросов должны завершиться ошибкой. */
  failNext = 0;
  private seq = 0;

  constructor(private readonly failRate = 0) {}

  private maybeFail(): void {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Тестовая CRM: сервис недоступен (имитация сбоя)');
    }
    if (this.failRate > 0 && Math.random() < this.failRate) {
      throw new Error('Тестовая CRM: случайный сбой (имитация)');
    }
  }

  async createLead(lead: LeadPayload): Promise<string> {
    this.calls.create++;
    this.maybeFail();
    const id = String(++this.seq);
    this.leads.set(id, lead);
    return id;
  }

  async updateLead(crmId: string, lead: LeadPayload): Promise<void> {
    this.calls.update++;
    this.maybeFail();
    if (!this.leads.has(crmId)) throw new Error(`Тестовая CRM: лид ${crmId} не найден`);
    this.leads.set(crmId, lead);
  }
}
