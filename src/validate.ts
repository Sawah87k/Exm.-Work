export type ValidLead = {
  name: string;
  phone: string | null;
  email: string | null;
  message: string;
};

export type ValidationResult =
  | { kind: 'ok'; lead: ValidLead }
  | { kind: 'invalid'; errors: Record<string, string> }
  | { kind: 'spam' };

/** Приводит телефон к виду +7XXXXXXXXXX. Десять цифр считаем российским номером без кода страны. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  else if (digits.length === 10) digits = '7' + digits;
  return digits.length >= 11 && digits.length <= 15 ? '+' + digits : null;
}

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Проверяет данные формы.
 * Поле `website` — «ловушка» для ботов: человек его не видит и не заполняет.
 */
export function validateLead(input: Record<string, unknown>): ValidationResult {
  if (str(input.website) !== '') return { kind: 'spam' };

  const errors: Record<string, string> = {};
  const name = str(input.name);
  const rawPhone = str(input.phone);
  const rawEmail = str(input.email);
  const message = str(input.message);

  if (name.length < 2 || name.length > 100) errors.name = 'Укажите имя от 2 до 100 символов';

  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (rawPhone && !phone) errors.phone = 'Не удалось распознать номер телефона';
  if (rawEmail && !email) errors.email = 'Не удалось распознать адрес почты';
  if (!rawPhone && !rawEmail) errors.contact = 'Укажите телефон или почту';

  if (message.length > 2000) errors.message = 'Сообщение длиннее 2000 символов';

  if (Object.keys(errors).length > 0) return { kind: 'invalid', errors };
  return { kind: 'ok', lead: { name, phone, email, message } };
}
