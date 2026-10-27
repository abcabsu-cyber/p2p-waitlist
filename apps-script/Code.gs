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
];
const VISIT_COLUMNS = [
  ['Дата',          '_date'],
  ['tg_id',         'tg_id'],
  ['Видео',         'video'],
  ['cuid (BotHelp)','cuid'],
  ['UTM',           'utm'],
];
const TG_ID_COL = 2; // колонка B в обоих листах

function doPost(e) {
  const p = (e && e.parameter) || {};
  const isVisit = p.event === 'visit';
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cols = isVisit ? VISIT_COLUMNS : COLUMNS;
    const sheet = getSheet_(isVisit ? VISITS_SHEET : SHEET_NAME, cols);
    sheet.appendRow(cols.map(([, key]) => key === '_date' ? new Date() : asText_(p[key])));
  } finally {
    lock.releaseLock();
  }
  if (!isVisit) notifyBot_(p);
  return json_({ ok: true });
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
