import type { DatabaseSync } from 'node:sqlite';
import type { CrmClient } from './crm.ts';
import type { ValidLead } from './validate.ts';

export const MAX_ATTEMPTS = 5;

export type Lead = {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  message: string;
  status: 'pending' | 'sent' | 'failed';
  crm_id: string | null;
  attempts: number;
  duplicates: number;
  last_error: string | null;
  next_retry_at: number;
  created_at: number;
  updated_at: number;
};

export type LogRow = {
  id: number;
  lead_id: number | null;
  level: 'info' | 'warn' | 'error';
  message: string;
  created_at: number;
};

/** Пауза перед следующей попыткой: 1, 2, 4, 8 минут... но не больше часа. */
export const backoffSeconds = (attempts: number): number =>
  Math.min(60 * 2 ** (attempts - 1), 3600);

export class LeadService {
  /** id заявок, которые прямо сейчас отправляются. Защита от двойной отправки. */
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly crm: CrmClient,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private log(level: LogRow['level'], leadId: number | null, message: string): void {
    this.db
      .prepare('INSERT INTO logs (lead_id, level, message, created_at) VALUES (?, ?, ?, ?)')
      .run(leadId, level, message, this.now());
    console.log(`[${level}] ${leadId !== null ? `заявка #${leadId}: ` : ''}${message}`);
  }

  getLead(id: number): Lead | undefined {
    return this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as Lead | undefined;
  }

  /**
   * Сохраняет заявку в базу. Если клиент с таким телефоном или почтой уже есть,
   * новая заявка объединяется со старой, а не создаёт вторую карточку.
   * Между SELECT и INSERT нет await, поэтому в одном процессе Node гонки здесь не будет.
   */
  accept(input: ValidLead): { id: number; duplicate: boolean } {
    const t = this.now();
    const existing = this.db
      .prepare(
        `SELECT * FROM leads
          WHERE (phone IS NOT NULL AND phone = ?) OR (email IS NOT NULL AND email = ?)
          ORDER BY id LIMIT 1`,
      )
      .get(input.phone, input.email) as unknown as Lead | undefined;

    if (existing) {
      let message = existing.message;
      if (input.message && !message.includes(input.message)) {
        message = message ? `${message}\n---\n${input.message}` : input.message;
      }
      this.db
        .prepare(
          `UPDATE leads
              SET message = ?, phone = COALESCE(phone, ?), email = COALESCE(email, ?),
                  duplicates = duplicates + 1, status = 'pending', attempts = 0,
                  last_error = NULL, next_retry_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(message.slice(-4000), input.phone, input.email, t, t, existing.id);
      this.log('info', existing.id, 'Повторная заявка от того же клиента: объединена с существующей');
      return { id: existing.id, duplicate: true };
    }

    const result = this.db
      .prepare(
        `INSERT INTO leads (name, phone, email, message, next_retry_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.name, input.phone, input.email, input.message, t, t, t);
    const id = Number(result.lastInsertRowid);
    this.log('info', id, 'Новая заявка сохранена');
    return { id, duplicate: false };
  }

  /** Отправляет заявку в CRM. Ошибки не пробрасываются: они попадают в журнал и планируют новую попытку. */
  async sync(id: number): Promise<void> {
    if (this.inFlight.has(id)) return;
    const lead = this.getLead(id);
    if (!lead || lead.status === 'sent' || lead.status === 'failed') return;

    this.inFlight.add(id);
    const payload = { name: lead.name, phone: lead.phone, email: lead.email, message: lead.message };
    try {
      let crmId = lead.crm_id;
      if (crmId) {
        await this.crm.updateLead(crmId, payload);
      } else {
        crmId = await this.crm.createLead(payload);
      }
      this.db
        .prepare(
          `UPDATE leads SET status = 'sent', crm_id = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(crmId, this.now(), id);
      this.log('info', id, `Передана в CRM (лид ${crmId})`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const attempts = lead.attempts + 1;
      const gaveUp = attempts >= MAX_ATTEMPTS;
      this.db
        .prepare(
          `UPDATE leads
              SET status = ?, attempts = ?, last_error = ?, next_retry_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          gaveUp ? 'failed' : 'pending',
          attempts,
          error,
          this.now() + backoffSeconds(attempts),
          this.now(),
          id,
        );
      this.log(
        'error',
        id,
        gaveUp
          ? `Не удалось передать после ${attempts} попыток: ${error}. Нужна ручная проверка`
          : `Ошибка передачи (попытка ${attempts} из ${MAX_ATTEMPTS}): ${error}`,
      );
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Повторяет отправку всех заявок, у которых подошло время. Вызывается по таймеру. */
  async retryDue(): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT id FROM leads
          WHERE status = 'pending' AND next_retry_at <= ?
          ORDER BY next_retry_at LIMIT 20`,
      )
      .all(this.now()) as unknown as { id: number }[];
    for (const { id } of rows) await this.sync(id);
    return rows.length;
  }

  /** Ручной повтор из интерфейса менеджера: сбрасывает счётчик и сразу пробует снова. */
  async retryNow(id: number): Promise<void> {
    const lead = this.getLead(id);
    if (!lead || lead.status === 'sent') return;
    this.db
      .prepare(
        `UPDATE leads SET status = 'pending', attempts = 0, next_retry_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(this.now(), this.now(), id);
    this.log('info', id, 'Ручной повтор отправки');
    await this.sync(id);
  }

  listLeads(limit = 100): Lead[] {
    return this.db
      .prepare('SELECT * FROM leads ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(limit) as unknown as Lead[];
  }

  recentLogs(limit = 30): LogRow[] {
    return this.db
      .prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as LogRow[];
  }

  stats(): { total: number; sent: number; pending: number; failed: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status = 'sent'), 0)    AS sent,
                COALESCE(SUM(status = 'pending'), 0) AS pending,
                COALESCE(SUM(status = 'failed'), 0)  AS failed
           FROM leads`,
      )
      .get() as unknown as { total: number; sent: number; pending: number; failed: number };
    return row;
  }
}
