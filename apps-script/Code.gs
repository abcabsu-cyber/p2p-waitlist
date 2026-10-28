/**
 * Анкеты предзаписи → Google Таблица + связь с ботом BotHelp. Версия с защитой.
 *
 * doPost — сайт присылает:
 *   • event=visit (человек открыл сайт по ссылке из бота) → лист «Визиты»;
 *   • анкету → лист «Заявки» + сразу ссылка на канал в бот (API BotHelp).
 *   Ответ всегда JSON {"ok":true|false}; сайт показывает «Анкета принята» только при ok:true.
 * doGet ?tg_id=…&key=… — статус для BotHelp: filled | visited | none.
 *
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   BOTHELP_CLIENT_ID, BOTHELP_CLIENT_SECRET — ключи API BotHelp;
 *   STATUS_KEY — секрет для проверки статуса (создаётся функцией makeStatusKey).
 *
 * Функции для ручного запуска: setup, checkBotHelp, makeStatusKey. НЕ запускайте doPost/doGet.
 */

const SHEET_NAME = 'Заявки';
const VISITS_SHEET = 'Визиты';
const RESERVE_SHEET = 'Запас'; // сюда пишется анкета, если основной лист недоступен
// Рабочий адрес развёртывания (тот же, что SCRIPT_URL на сайте). Меняйте, только если создали новое развёртывание.
const PUBLIC_EXEC_URL = 'https://script.google.com/macros/s/AKfycbzPe9IAuuMJ0DmAUBz7d63n7A5KpqblkxUNqwXMj74lmVMEkLqWlxiKyKXUY0oBHV-yuw/exec';

// Необязательно: адрес, куда скрипт сообщит о новой анкете (POST, JSON).
const BOT_WEBHOOK_URL = '';

// ---------- Мгновенная ссылка на канал в боте (API BotHelp) ----------
// Слово из конца ссылки (video) → ref бота и ref шага «Анкета заполнена → канал».
// Ref бота: BotHelp → кнопка 🔗 «Ссылки» → «Идентификатор для интеграций».
// Ref шага: открыть шаг → строка «Ref шага».
const BOTHELP_FLOWS = {
  chalenge:  { bot: 'c1793043434056', step: '1793122782287' },
  challenge: { bot: 'c1793043434056', step: '1793122782287' },
};
const BOTHELP_DEFAULT_FLOW = BOTHELP_FLOWS.chalenge;

// ---------- Лимиты (защита от ботов и перебора) ----------
const LIMITS = {
  formsPerMinute: 30,     // анкет в минуту БЕЗ подтверждённого визита (подозрительные)
  pairedFormsPerMinute: 120, // анкет в минуту от людей, пришедших по своей ссылке из бота
  visitsPerMinute: 150,   // визитов со всего сайта в минуту
  formsPerTgId10m: 3,     // анкет от одного tg_id за 10 минут
  botRunsPer10m: 30,      // запусков бота за 10 минут; выше — «предохранитель»
  minFillMs: 4000,        // анкету быстрее 4 секунд заполняет только робот
};

// ---------- Колонки ----------
// [заголовок, поле]. Поля с «_» вычисляет сервер — с сайта их подменить нельзя.
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
  ['ID анкеты',              'sid'],
];
const BOT_COL = 15; // O
const VISIT_COLUMNS = [
  ['Дата',          '_date'],
  ['tg_id',         'tg_id'],
  ['Видео',         'video'],
  ['cuid (BotHelp)','cuid'],
  ['UTM',           'utm'],
];
const TG_ID_COL = 2; // B в обоих листах
const VISIT_CUID_COL = 4; // D в «Визитах»

const EXPERIENCE_VALUES = [
  'Не имеешь представления, что делать',
  'Не работал, но имеешь представление, что делать',
  'Уже работал',
];

// =====================================================================

function doPost(e) {
  try {
    if (!e || !e.parameter || !Object.keys(e.parameter).length) return json_({ ok: false, error: 'empty' });
    if (e.postData && e.postData.length > 20000) return json_({ ok: false, error: 'too_large' });
    const raw = e.parameter;
    return raw.event === 'visit' ? handleVisit_(raw) : handleForm_(raw);
  } catch (err) {
    console.error('doPost', err && err.stack || err);
    alertOwner_('Ошибка doPost', String(err && err.stack || err));
    return json_({ ok: false, error: 'server' });
  }
}

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const key = PropertiesService.getScriptProperties().getProperty('STATUS_KEY');
    // Пока STATUS_KEY не создан — отвечаем как раньше, чтобы бот не сломался.
    if (key && p.key !== key) return json_({ ok: false, error: 'forbidden' });
    const tgId = cleanTgId_(p.tg_id);
    if (!tgId) return json_({ ok: true, status: 'none', filled: false });
    const filled = findRow_(SHEET_NAME, tgId) > 0;
    const visited = filled || findRow_(VISITS_SHEET, tgId) > 0;
    const status = filled ? 'filled' : visited ? 'visited' : 'none';
    return json_({ ok: true, status: status, filled: filled });
  } catch (err) {
    console.error('doGet', err && err.stack || err);
    return json_({ ok: false, status: 'error', filled: false });
  }
}

// ---------- визит ----------

function handleVisit_(raw) {
  const p = clean_(raw);
  if (!p.tg_id) return json_({ ok: false, error: 'no_tg_id' });
  if (!rate_('visits', LIMITS.visitsPerMinute, 60)) return json_({ ok: false, error: 'rate' });
  // Один визит той же пары tg_id+cuid за 30 минут — дальше не дублируем.
  if (!once_('v:' + p.tg_id + ':' + p.cuid, 1800)) return json_({ ok: true, dup: true });
  appendSafe_(VISITS_SHEET, VISIT_COLUMNS, p);
  return json_({ ok: true });
}

// ---------- анкета ----------

function handleForm_(raw) {
  // Ловушка для роботов: скрытое поле «website» и слишком быстрое заполнение.
  const elapsed = Number(raw.t_ms || 0);
  if (String(raw.website || '').trim() || (elapsed && elapsed < LIMITS.minFillMs)) {
    console.warn('bot trap', { website: !!raw.website, elapsed: elapsed });
    return json_({ ok: true }); // роботу не подсказываем, что его поймали
  }
  const p = clean_(raw);
  if (!p.name_age_city || !p.telegram || !p.whatsapp) return json_({ ok: false, error: 'required' });
  // Настоящие люди (визит этой пары tg_id+cuid уже есть) идут по отдельному лимиту —
  // поток поддельных анкет не может «выбить» реальных людей.
  const paired = !!(p.tg_id && p.cuid && pairVisited_(p.tg_id, p.cuid));
  if (!rate_(paired ? 'forms_paired' : 'forms', paired ? LIMITS.pairedFormsPerMinute : LIMITS.formsPerMinute, 60)) return json_({ ok: false, error: 'rate' });
  if (p.tg_id && !rate_('form:' + p.tg_id, LIMITS.formsPerTgId10m, 600)) return json_({ ok: false, error: 'rate' });
  // Повторная отправка той же анкеты (двойной клик, повтор после таймаута). Проверка под замком — без гонки.
  if (p.sid && !claim_('sid:' + p.sid, 21600)) return json_({ ok: true, dup: true });

  let where;
  try { where = appendSafe_(SHEET_NAME, COLUMNS, p); }
  catch (err) { if (p.sid) release_('sid:' + p.sid); throw err; }
  const res = sendChannelNow_(p);
  if (where.sheet === SHEET_NAME && where.row) {
    try { where.ref.getRange(where.row, BOT_COL).setValue(res); } catch (err) { console.error('bot col', err); }
  }
  if (/^ошибка|не остановлен/.test(res)) alertOwner_('BotHelp: ссылка на канал не ушла', res + '\ntg_id ' + p.tg_id + ', cuid ' + p.cuid);
  notifyBot_(p);
  return json_({ ok: true });
}

/** Запись строки: под замком; если замок занят — без него; если лист сломан — в «Запас». */
function appendSafe_(name, cols, p) {
  const row = cols.map(([, key]) => key === '_date' ? new Date() : key.charAt(0) === '_' ? '' : asText_(p[key]));
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(10000);
  try {
    const sheet = getSheet_(name, cols);
    sheet.appendRow(row);
    return { sheet: name, ref: sheet, row: locked ? sheet.getLastRow() : findRowBySid_(sheet, p.sid) };
  } catch (err) {
    console.error('append failed', name, err);
    alertOwner_('Анкета сохранена в запасной лист', String(err) + '\n' + JSON.stringify(p));
    const reserve = getSheet_(RESERVE_SHEET, [['Дата', '_date'], ['Лист', '_s'], ['Данные', '_j']]);
    reserve.appendRow([new Date(), name, asText_(JSON.stringify(p))]);
    return { sheet: RESERVE_SHEET };
  } finally {
    if (locked) lock.releaseLock();
  }
}

// ---------- BotHelp ----------

/** Останавливает дожим и сразу отправляет шаг со ссылкой на канал. Возвращает итог для колонки O. */
function sendChannelNow_(p) {
  if (!p.cuid) return 'нет cuid — придёт при проверке';
  if (!p.tg_id) return 'нет tg_id — придёт при проверке';
  // Защита от перебора: только если эта пара tg_id + cuid до этого открыла сайт по своей ссылке.
  if (!pairVisited_(p.tg_id, p.cuid)) return 'не найден визит этой пары — придёт при проверке';
  const sentKey = 'sent:' + p.cuid;
  const props = PropertiesService.getScriptProperties();
  if (!claimProp_(sentKey)) return 'уже отправлялось раньше'; // под замком: двойной отправки не будет
  if (!rate_('botruns', LIMITS.botRunsPer10m, 600)) {
    alertOwner_('Сработал предохранитель BotHelp', 'Больше ' + LIMITS.botRunsPer10m + ' запусков бота за 10 минут. Запуски приостановлены; проверьте лист «Заявки».');
    return 'предохранитель — придёт при проверке';
  }
  const flow = BOTHELP_FLOWS[p.video] || BOTHELP_DEFAULT_FLOW;
  const note = BOTHELP_FLOWS[p.video] ? '' : ' (бот по умолчанию: слово «' + p.video + '» не в списке)';
  try {
    const base = 'https://api.bothelp.io/v1/subscribers/cuid/' + encodeURIComponent(p.cuid) + '/bot';
    const stop = bhFetch_(base + '?botReferral=' + encodeURIComponent(flow.bot), { method: 'delete' });
    const run = bhFetch_(base, { method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ botReferral: flow.bot, stepReferral: flow.step }) });
    if (!run) { props.deleteProperty(sentKey); return 'нет ключей API — придёт при проверке'; }
    const ok = c => c >= 200 && c < 300;
    if (!ok(run.getResponseCode())) {
      props.deleteProperty(sentKey);
      console.error('BotHelp run', run.getResponseCode(), run.getContentText().slice(0, 300));
      return 'ошибка ' + run.getResponseCode() + ': ' + run.getContentText().slice(0, 100);
    }
    props.setProperty(sentKey, String(Date.now()));
    if (!ok(stop.getResponseCode())) return 'отправлено сразу, но дожим не остановлен (' + stop.getResponseCode() + ')' + note;
    return 'отправлено сразу' + note;
  } catch (err) {
    props.deleteProperty(sentKey);
    console.error('sendChannelNow_', err);
    return 'ошибка: ' + String(err).slice(0, 120);
  }
}

/** Запрос к API BotHelp: токен, повтор после 401 (новый токен) и после 429/5xx (пауза). */
function bhFetch_(url, opts) {
  let token = bothelpToken_(false);
  if (!token) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } }, opts));
    const code = res.getResponseCode();
    if (code === 401 && attempt === 0) { token = bothelpToken_(true); continue; }
    if ((code === 429 || code >= 500) && attempt === 0) { Utilities.sleep(1500); continue; }
    return res;
  }
}

function bothelpToken_(force) {
  const cache = CacheService.getScriptCache();
  if (force) cache.remove('bothelp_token');
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
  if (res.getResponseCode() !== 200) throw new Error('OAuth ' + res.getResponseCode());
  let data;
  try { data = JSON.parse(res.getContentText()); } catch (_) { throw new Error('OAuth: ответ не JSON'); }
  if (!data.access_token) throw new Error('OAuth: в ответе нет access_token');
  cache.put('bothelp_token', data.access_token, Math.max(60, Math.min(3000, (data.expires_in || 3600) - 300)));
  return data.access_token;
}

// ---------- проверки и очистка данных ----------

/** Белый список полей + проверка формата. Всё лишнее с сайта отбрасывается. */
function clean_(r) {
  const s = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const exp = s(r.experience, 80);
  let rd = parseInt(r.readiness, 10);
  rd = isNaN(rd) ? '' : String(Math.max(0, Math.min(10, rd)));
  const phone = v => { const x = s(v, 40); return /^[+\d\s()\-]*$/.test(x) ? x : x.replace(/[^+\d\s()\-]/g, '').slice(0, 40); };
  const call = s(r.call, 40);
  return {
    tg_id: cleanTgId_(r.tg_id),
    cuid: /^[a-z0-9]{1,16}\.\d{1,10}$/i.test(s(r.cuid, 30)) ? s(r.cuid, 30) : '',
    video: /^[a-z0-9_-]{1,32}$/i.test(s(r.video, 32)) ? s(r.video, 32).toLowerCase() : '',
    utm: s(r.utm, 300),
    name_age_city: s(r.name_age_city, 200),
    deposit: s(r.deposit, 100),
    experience: EXPERIENCE_VALUES.indexOf(exp) >= 0 ? exp : '',
    instagram: s(r.instagram, 40).replace(/[^A-Za-z0-9_.]/g, ''),
    telegram: s(r.telegram, 40).replace(/[^A-Za-z0-9_@]/g, ''),
    whatsapp: phone(r.whatsapp),
    call: /\d/.test(call) ? phone(call) : call.slice(0, 20),
    goal: s(r.goal, 1000),
    readiness: rd,
    sid: /^[a-z0-9-]{8,40}$/i.test(s(r.sid, 40)) ? s(r.sid, 40) : '',
  };
}

function cleanTgId_(v) {
  const x = String(v == null ? '' : v).trim();
  return /^\d{5,15}$/.test(x) ? x : '';
}

/** Счётчик за окно времени. false — лимит превышен. */
function rate_(name, max, seconds) {
  const cache = CacheService.getScriptCache();
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const key = 'rl:' + name + ':' + bucket;
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), seconds + 5);
  return n <= max;
}

/** Атомарно «занять» ключ в кэше (под замком). false — уже занят. */
function claim_(key, seconds) {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(5000);
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get(key)) return false;
    cache.put(key, '1', seconds);
    return true;
  } finally { if (locked) lock.releaseLock(); }
}
function release_(key) { CacheService.getScriptCache().remove(key); }

/** То же для постоянного хранилища (Свойства скрипта). */
function claimProp_(key) {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(key)) return false;
    props.setProperty(key, 'pending:' + Date.now());
    return true;
  } finally { if (locked) lock.releaseLock(); }
}

/** true — первый раз за указанное время, false — уже было. */
function once_(key, seconds) {
  const cache = CacheService.getScriptCache();
  if (cache.get('once:' + key)) return false;
  cache.put('once:' + key, '1', seconds);
  return true;
}

function pairVisited_(tgId, cuid) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(VISITS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return false;
  const cells = sheet.getRange(2, TG_ID_COL, sheet.getLastRow() - 1, 1).createTextFinder(tgId).matchEntireCell(true).findAll();
  return cells.some(c => String(sheet.getRange(c.getRow(), VISIT_CUID_COL).getValue()) === cuid);
}

/** Только чтение — ничего не создаёт и не пишет. */
function findRow_(name, tgId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const c = sheet.getRange(2, TG_ID_COL, sheet.getLastRow() - 1, 1).createTextFinder(tgId).matchEntireCell(true).findNext();
  return c ? c.getRow() : 0;
}

function findRowBySid_(sheet, sid) {
  if (!sid) return 0;
  const col = COLUMNS.findIndex(c => c[1] === 'sid') + 1;
  const c = sheet.getRange(2, col, Math.max(1, sheet.getLastRow() - 1), 1).createTextFinder(sid).matchEntireCell(true).findNext();
  return c ? c.getRow() : 0;
}

// Текст в ячейку как есть: апостроф не даёт таблице выполнить «формулу» из анкеты
// и превратить длинный tg_id в число.
function asText_(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 2000);
  return s ? "'" + s : '';
}

// ---------- письма владельцу (не чаще раза в час на одну тему) ----------

function alertOwner_(subject, body) {
  try {
    if (!once_('alert:' + subject, 3600)) return;
    const to = Session.getEffectiveUser().getEmail();
    if (to) MailApp.sendEmail(to, '[Предзапись P2P] ' + subject, body + '\n\nТаблица: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl());
  } catch (err) {
    console.error('alertOwner_', err);
  }
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

function notifyBot_(p) {
  if (!BOT_WEBHOOK_URL) return;
  try {
    UrlFetchApp.fetch(BOT_WEBHOOK_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ event: 'form_submitted', tg_id: p.tg_id, cuid: p.cuid, video: p.video, readiness: p.readiness }),
    });
  } catch (err) {
    console.error('notifyBot_', err);
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================
// Ручной запуск (кнопка «Выполнить»)

/** Создаёт листы и шапки, запрашивает разрешения (таблица, внешние запросы, почта). */
function setup() {
  getSheet_(SHEET_NAME, COLUMNS);
  getSheet_(VISITS_SHEET, VISIT_COLUMNS);
  console.log('✅ Листы готовы. Почта для оповещений: ' + Session.getEffectiveUser().getEmail());
}

/** Проверяет ключи API BotHelp. Ничего никому не отправляет. */
function checkBotHelp() {
  const token = bothelpToken_(true);
  if (!token) { console.log('❌ Ключи не найдены. Добавьте BOTHELP_CLIENT_ID и BOTHELP_CLIENT_SECRET в Свойства скрипта.'); return; }
  const res = UrlFetchApp.fetch('https://api.bothelp.io/v1/bots', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  console.log(res.getResponseCode() === 200 ? '✅ Ключи работают, BotHelp отвечает.' : '❌ BotHelp ответил ' + res.getResponseCode());
}

/** Создаёт секретный ключ для проверки статуса и показывает готовый адрес для BotHelp. */
function makeStatusKey() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('STATUS_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('STATUS_KEY', key);
  }
  console.log('Адрес для «Внешнего запроса» в BotHelp (во всех шагах «Проверка анкеты»):\n' +
    PUBLIC_EXEC_URL + '?tg_id={%user_id%}&key=' + key);
}
