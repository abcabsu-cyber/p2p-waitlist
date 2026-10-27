/**
 * Приём анкет с сайта предзаписи → Google Таблица (+ связь с ботом).
 *
 * doPost  — сайт присылает анкету, скрипт пишет строку в лист «Заявки»
 *           и (если задан BOT_WEBHOOK_URL) сообщает боту, что человек заполнил анкету.
 * doGet   — бот спрашивает ?tg_id=123 и получает {"ok":true,"filled":true|false}.
 *           Перед каждым дожимающим сообщением бот проверяет: заполнил — не шлём.
 *
 * Установка — см. apps-script/README.md
 */

const SHEET_NAME = 'Заявки';

// Необязательно: адрес, куда скрипт сообщит боту о новой анкете (POST, JSON).
// Оставьте пустым, если бот сам проверяет статус через doGet.
const BOT_WEBHOOK_URL = '';

// Порядок колонок в таблице: [заголовок, имя поля в форме]
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
];
const TG_ID_COL = 2; // колонка B

function doPost(e) {
  const p = (e && e.parameter) || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet_();
    const row = COLUMNS.map(([, key]) => key === '_date' ? new Date() : asText_(p[key]));
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  notifyBot_(p);
  return json_({ ok: true });
}

function doGet(e) {
  const tgId = String((e && e.parameter && e.parameter.tg_id) || '').trim();
  if (!tgId) return json_({ ok: true, service: 'p2p-waitlist' });
  return json_({ ok: true, tg_id: tgId, filled: hasTgId_(tgId) });
}

/** Запустите один раз вручную: создаст лист и шапку. */
function setup() {
  getSheet_();
}

// ---------- служебное ----------

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS.map(([title]) => title));
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
  }
  return sheet;
}

function hasTgId_(tgId) {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const found = sheet.getRange(2, TG_ID_COL, last - 1, 1)
    .createTextFinder(tgId).matchEntireCell(true).findNext();
  return !!found;
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
