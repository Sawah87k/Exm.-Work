import { DatabaseSync } from 'node:sqlite';

/** Открывает базу SQLite и создаёт таблицы, если их ещё нет. */
export function openDb(path: string = process.env.DB_PATH ?? 'leads.db'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS leads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      phone         TEXT,                 -- нормализованный: +7XXXXXXXXXX
      email         TEXT,                 -- в нижнем регистре
      message       TEXT    NOT NULL DEFAULT '',
      status        TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed')),
      crm_id        TEXT,                 -- id лида в CRM после успешной отправки
      attempts      INTEGER NOT NULL DEFAULT 0,
      duplicates    INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      next_retry_at INTEGER NOT NULL,     -- unix-время, секунды
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
    CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
    CREATE INDEX IF NOT EXISTS idx_leads_retry ON leads(status, next_retry_at);

    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id    INTEGER,
      level      TEXT    NOT NULL,        -- info | warn | error
      message    TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}
