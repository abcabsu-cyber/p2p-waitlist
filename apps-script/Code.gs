/**
 * Анкеты предзаписи → Google Таблица + связь с ботом BotHelp.
 *
 * doPost  — сайт присылает:
 *           • анкету → строка в лист «Заявки»;
 *           • event=visit (человек открыл сайт по ссылке из бота) → строка в лист «Визиты».
 * doGet   — бот спрашивает статус человека: ?tg_id=123
 *           Ответ: {"ok":true,"tg_id":"123","status":"filled"|"visited"|"none","filled":true|false}
 *             filled  — анкета заполнена
 *             visited — открыл сайт, но анкету не отправил
 *             none    — на сайт не переходил
 *           В BotHelp это делается действием «Внешний запрос» перед каждым дожимом.
 *
 * Установка и настройка бота — см. apps-script/README.md
 */

const SHEET_NAME = 'Заявки';
const VISITS_SHEET = 'Визиты';

// Необязательно: адрес, куда скрипт сообщит о новой анкете (POST, JSON).
const BOT_WEBHOOK_URL = '';

// ---------- Мгновенная ссылка на канал в боте (API BotHelp) ----------
// Сразу после анкеты скрипт останавливает цепочку дожима и запускает бота
// на шаге «Анкета заполнена → канал». Ключи API хранятся в «Свойствах скрипта»:
//   BOTHELP_CLIENT_ID, BOTHELP_CLIENT_SECRET  (Настройки проекта → Свойства скрипта).
// Для каждого материала: слово из конца ссылки (video) → ref бота и ref шага «канал».
// Ref бота: в BotHelp кнопка 🔗 «Ссылки» → «Идентификатор для интеграций».
// Ref шага: открыть шаг → строка «Ref шага» под названием.
const BOTHELP_FLOWS = {
  chalenge:  { bot: 'c1793043434056', step: '1793122782287' },
  challenge: { bot: 'c1793043434056', step: '1793122782287' },
};
const BOTHELP_DEFAULT_FLOW = BOTHELP_FLOWS.chalenge; // если слово не найдено в списке

// Порядок колонок в «Заявках»: [заголовок, имя поля в форме]. Новые колонки — только в конец.
const COLUMNS = [
  ['Дата',                   '_date'],
  ['tg_id',                  'tg_id'],
  ['Видео',                  'video'],
  ['UTM',                    'utm'],
  ['Имя, возраст, город',    'name_age_city'],
  ['Депозит',                'deposit'],
  ['Опыт',                   'experience'],
  ['Instagram',              'instagram'],
  ['Telegram',               'telegram'],
  ['WhatsApp',               'whatsapp'],
  ['Номер для звонков',      'call'],
  ['Идеальный результат',    'goal'],
  ['Готовность (0–10)',      'readiness'],
  ['cuid (BotHelp)',         'cuid'],
  ['Канал в боте',           '_bot'],
];
const BOT_COL = 15; // колонка O — результат отправки ссылки на канал в бот
const VISIT_COLUMNS = [
  ['Дата',          '_date'],
  ['tg_id',         'tg_id'],
  ['Видео',         'video'],
  ['cuid (BotHelp)','cuid'],
  ['UTM',           'utm'],
];
const TG_ID_COL = 2; // колонка B в обоих листах

function doPost(e) {
  // Запуск из редактора (кнопка «Выполнить») приходит без данных — ничего не пишем.
  if (!e || !e.parameter || !Object.keys(e.parameter).length) {
    return json_({ ok: false, error: 'empty request' });
  }
  const p = e.parameter;
  const isVisit = p.event === 'visit';
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let sheet, row;
  try {
    const cols = isVisit ? VISIT_COLUMNS : COLUMNS;
    sheet = getSheet_(isVisit ? VISITS_SHEET : SHEET_NAME, cols);
    sheet.appendRow(cols.map(([, key]) => key === '_date' ? new Date() : key === '_bot' ? '' : asText_(p[key])));
    row = sheet.getLastRow();
  } finally {
    lock.releaseLock();
  }
  if (!isVisit) {
    const res = sendChannelNow_(p);
    try { sheet.getRange(row, BOT_COL).setValue(res); } catch (err) { console.error(err); }
    notifyBot_(p);
  }
  return json_({ ok: true });
}

/** Останавливает дожим и сразу отправляет в бот шаг со ссылкой на канал. Возвращает итог для таблицы. */
function sendChannelNow_(p) {
  const cuid = String(p.cuid || '').trim();
  if (!cuid) return 'нет cuid — придёт при проверке';
  const flow = BOTHELP_FLOWS[String(p.video || '').trim().toLowerCase()] || BOTHELP_DEFAULT_FLOW;
  try {
    const token = bothelpToken_();
    if (!token) return 'нет ключей API — придёт при проверке';
    const base = 'https://api.bothelp.io/v1/subscribers/cuid/' + encodeURIComponent(cuid) + '/bot';
    const auth = { Authorization: 'Bearer ' + token };
    const stop = UrlFetchApp.fetch(base + '?botReferral=' + encodeURIComponent(flow.bot),
      { method: 'delete', headers: auth, muteHttpExceptions: true });
    const run = UrlFetchApp.fetch(base, {
      method: 'post', headers: auth, contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ botReferral: flow.bot, stepReferral: flow.step }),
    });
    const code = run.getResponseCode();
    if (code === 200) return 'отправлено сразу';
    console.error('BotHelp run', code, run.getContentText(), 'stop', stop.getResponseCode(), stop.getContentText());
    return 'ошибка ' + code + ': ' + run.getContentText().slice(0, 120);
  } catch (err) {
    console.error('sendChannelNow_', err);
    return 'ошибка: ' + String(err).slice(0, 120);
  }
}

function bothelpToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('bothelp_token');
  if (cached) return cached;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('BOTHELP_CLIENT_ID');
  const secret = props.getProperty('BOTHELP_CLIENT_SECRET');
  if (!id || !secret) return '';
  const res = UrlFetchApp.fetch('https://oauth.bothelp.io/oauth2/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'client_credentials', client_id: id, client_secret: secret },
  });
  if (res.getResponseCode() !== 200) throw new Error('OAuth ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  const data = JSON.parse(res.getContentText());
  cache.put('bothelp_token', data.access_token, Math.max(60, Math.min(3000, (data.expires_in || 3600) - 300)));
  return data.access_token;
}

/** Запустите вручную после ввода ключей: проверит, что ключи API работают. Ничего никому не отправляет. */
function checkBotHelp() {
  const token = bothelpToken_();
  if (!token) { console.log('❌ Ключи не найдены. Добавьте BOTHELP_CLIENT_ID и BOTHELP_CLIENT_SECRET в Свойства скрипта.'); return; }
  const res = UrlFetchApp.fetch('https://api.bothelp.io/v1/bots', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  console.log(res.getResponseCode() === 200 ? '✅ Ключи работают, BotHelp отвечает.' : '❌ BotHelp ответил ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
}

function doGet(e) {
  const tgId = String((e && e.parameter && e.parameter.tg_id) || '').trim();
  if (!tgId) return json_({ ok: true, service: 'p2p-waitlist' });
  const filled = hasTgId_(SHEET_NAME, COLUMNS, tgId);
  const visited = filled || hasTgId_(VISITS_SHEET, VISIT_COLUMNS, tgId);
  const status = filled ? 'filled' : visited ? 'visited' : 'none';
  return json_({ ok: true, tg_id: tgId, status: status, filled: filled });
}

/** Запустите вручную после обновления кода: создаст листы и обновит шапки. */
function setup() {
  getSheet_(SHEET_NAME, COLUMNS);
  getSheet_(VISITS_SHEET, VISIT_COLUMNS);
}

// ---------- служебное ----------

function getSheet_(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const titles = cols.map(([title]) => title);
  const head = sheet.getRange(1, 1, 1, titles.length);
  if (head.getValues()[0].join('\u0001') !== titles.join('\u0001')) {
    head.setValues([titles]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function hasTgId_(name, cols, tgId) {
  const sheet = getSheet_(name, cols);
  const last = sheet.getLastRow();
  if (last < 2) return false;
  return !!sheet.getRange(2, TG_ID_COL, last - 1, 1)
    .createTextFinder(tgId).matchEntireCell(true).findNext();
}

// Текст в ячейку как есть: «+7 928…» иначе таблица примет за формулу,
// а длинный tg_id превратит в число.
function asText_(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 2000);
  return s ? "'" + s : '';
}

function notifyBot_(p) {
  if (!BOT_WEBHOOK_URL) return;
  try {
    UrlFetchApp.fetch(BOT_WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        event: 'form_submitted',
        tg_id: p.tg_id || '',
        cuid: p.cuid || '',
        video: p.video || '',
        telegram: p.telegram || '',
        name: p.name_age_city || '',
        readiness: p.readiness || '',
      }),
    });
  } catch (err) {
    console.error('notifyBot_ failed', err);
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
