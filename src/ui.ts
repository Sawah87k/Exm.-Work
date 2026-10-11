import type { Lead, LogRow } from './service.ts';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const fmt = (sec: number): string =>
  new Date(sec * 1000).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

const STATUS: Record<Lead['status'], string> = {
  sent: 'В CRM',
  pending: 'В очереди',
  failed: 'Ошибка',
};

const CSS = `
:root{--bg:#f5f7f8;--ink:#17232b;--muted:#5d6b75;--line:#d8dfe4;--panel:#fff;
--ok:#1b7a50;--wait:#946200;--bad:#b3261e;--accent:#0e5a66}
@media (prefers-color-scheme:dark){:root{--bg:#10171b;--ink:#e6edf1;--muted:#93a2ac;--line:#27343c;
--panel:#172026;--ok:#4cc38a;--wait:#e0a93b;--bad:#ff7b72;--accent:#5cc3d3}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 20px 56px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:18px;margin:36px 0 10px}
.sub{color:var(--muted);margin:0 0 22px}
.counts{display:flex;flex-wrap:wrap;gap:6px 28px;margin:0 0 8px;padding:0;list-style:none}
.counts b{font-size:22px;margin-right:6px}
.wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;min-width:760px}
th,td{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{font-weight:600;color:var(--muted);font-size:13px}
tr:last-child td{border-bottom:0}
.st{font-weight:600}.st.sent{color:var(--ok)}.st.pending{color:var(--wait)}.st.failed{color:var(--bad)}
.muted{color:var(--muted)}.err{color:var(--bad);font-size:13px;max-width:320px;overflow-wrap:anywhere}
.msg{white-space:pre-wrap;color:var(--muted);font-size:13px;max-width:260px;overflow-wrap:anywhere}
button{font:inherit;padding:5px 10px;border:1px solid var(--accent);background:transparent;color:var(--accent);
border-radius:4px;cursor:pointer}
button:hover{background:var(--accent);color:var(--bg)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.log{font-size:13px;list-style:none;margin:0;padding:0}
.log li{padding:6px 12px;border-bottom:1px solid var(--line)}
.log li:last-child{border-bottom:0}
.log .error{color:var(--bad)}
.empty{padding:28px 16px;color:var(--muted)}
a{color:var(--accent)}
`;

const page = (title: string, body: string, head = ''): string => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}<style>${CSS}</style></head>
<body><main>${body}</main></body></html>`;

export function renderDashboard(
  leads: Lead[],
  logs: LogRow[],
  stats: { total: number; sent: number; pending: number; failed: number },
): string {
  const rows = leads
    .map((l) => {
      const contact = [l.phone, l.email].filter(Boolean).map(esc).join('<br>');
      const detail =
        l.status === 'sent'
          ? `<span class="muted">лид ${esc(l.crm_id)}</span>`
          : l.last_error
            ? `<div class="err">${esc(l.last_error)}</div>`
            : '';
      const retry =
        l.status === 'sent'
          ? ''
          : `<form method="post" action="/retry"><input type="hidden" name="id" value="${l.id}"><button>Повторить отправку</button></form>`;
      return `<tr>
<td>${l.id}</td>
<td><b>${esc(l.name)}</b><br><span class="muted">${contact}</span>${l.message ? `<div class="msg">${esc(l.message)}</div>` : ''}</td>
<td><span class="st ${l.status}">${STATUS[l.status]}</span><br>${detail}</td>
<td>${l.attempts}</td>
<td>${l.duplicates || ''}</td>
<td class="muted">${fmt(l.updated_at)}</td>
<td>${retry}</td></tr>`;
    })
    .join('');

  const logItems = logs
    .map((r) => `<li class="${r.level}"><span class="muted">${fmt(r.created_at)}</span> ${r.lead_id ? `#${r.lead_id} ` : ''}${esc(r.message)}</li>`)
    .join('');

  return page(
    'Заявки с сайта',
    `<h1>Заявки с сайта</h1>
<p class="sub">Страница обновляется каждые 15 секунд. Проверить приём заявок можно <a href="/demo">на тестовой форме</a>.</p>
<ul class="counts">
<li><b>${stats.total}</b>всего</li>
<li><b>${stats.sent}</b>в CRM</li>
<li><b>${stats.pending}</b>в очереди</li>
<li><b>${stats.failed}</b>с ошибкой</li></ul>
${
  leads.length === 0
    ? '<div class="wrap"><div class="empty">Заявок пока нет. Отправьте первую через тестовую форму.</div></div>'
    : `<div class="wrap"><table>
<thead><tr><th>№</th><th>Клиент</th><th>Статус</th><th>Попытки</th><th>Дубли</th><th>Обновлена</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>`
}
<h2>Журнал</h2>
<div class="wrap">${logs.length ? `<ul class="log">${logItems}</ul>` : '<div class="empty">Записей пока нет.</div>'}</div>`,
    '<meta http-equiv="refresh" content="15">',
  );
}

export function renderDemo(): string {
  return page(
    'Тестовая форма',
    `<h1>Тестовая форма заявки</h1>
<p class="sub"><a href="/">К списку заявок</a>. Отправьте одну и ту же заявку дважды с разным оформлением телефона, например 8 (900) 123-45-67 и +7 900 123 45 67, и посмотрите, что произойдёт.</p>
<form id="f" style="display:grid;gap:12px;max-width:420px">
<label>Имя<br><input name="name" required style="width:100%;padding:8px"></label>
<label>Телефон<br><input name="phone" style="width:100%;padding:8px"></label>
<label>Почта<br><input name="email" type="email" style="width:100%;padding:8px"></label>
<label>Сообщение<br><textarea name="message" rows="3" style="width:100%;padding:8px"></textarea></label>
<input name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
<div><button type="submit">Отправить заявку</button></div>
<p id="out" role="status" class="muted"></p>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = document.getElementById('out');
  const res = await fetch('/api/lead', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify(Object.fromEntries(new FormData(e.target)))});
  const data = await res.json();
  out.textContent = data.ok
    ? (data.duplicate ? 'Такой клиент уже есть: заявка объединена с прежней.' : 'Заявка принята.')
    : 'Ошибка: ' + Object.values(data.errors || {}).join('; ');
});
</script>`,
  );
}
