const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const http = require('http');

// === ЗӨВШӨӨРӨГДСӨН ЧАТУУД (WHITELIST) ===
const ALLOWED_CHAT_IDS = [
  '1920453419',
  '1447446407',
  '-1003019837728',
  '1932946217'
];

// === ТОХИРУУЛГА ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1qbxJsI4Ns3a8lluxlRZl5r5AKHA3hp9yS7YZLwY469A';
const SHEET_NAME = 'Transactions';
const SWIFT_SHEET_NAME = 'SWIFT';

function requireEnv(name, value) {
  if (!value || typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

requireEnv('BOT_TOKEN', BOT_TOKEN);

// === GOOGLE SHEETS AUTH ===
// Хэрэв SERVICE_ACCOUNT_JSON environment variable байвал тэрийг ашиглана,
// үгүй бол service-account.json файлаас уншина
function normalizePrivateKey(key) {
  if (!key || typeof key !== 'string') return key;

  let normalized = key.trim();

  // Зарим deployment орчинд "\\n" хэлбэрээр хадгалагддаг.
  normalized = normalized.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');

  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1);
  }

  return normalized;
}

function parseServiceAccountJson(rawValue) {
  if (!rawValue) return null;

  // 1) Шууд JSON
  try {
    return JSON.parse(rawValue);
  } catch (_) {
    // ignore
  }

  // 2) Base64-encoded JSON
  try {
    const decoded = Buffer.from(rawValue, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (_) {
    return null;
  }
}

function loadServiceAccountCredentials() {
  const jsonFromEnv = parseServiceAccountJson(process.env.SERVICE_ACCOUNT_JSON);
  if (jsonFromEnv) {
    if (jsonFromEnv.private_key) {
      jsonFromEnv.private_key = normalizePrivateKey(jsonFromEnv.private_key);
    }
    return jsonFromEnv;
  }

  const privateKey = normalizePrivateKey(
    process.env.SERVICE_ACCOUNT_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY
  );
  const clientEmail = process.env.SERVICE_ACCOUNT_CLIENT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  const projectId = process.env.SERVICE_ACCOUNT_PROJECT_ID || process.env.GOOGLE_PROJECT_ID;

  if (privateKey && clientEmail) {
    return {
      type: 'service_account',
      private_key: privateKey,
      client_email: clientEmail,
      project_id: projectId
    };
  }

  return null;
}

function validateServiceAccountCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') return false;
  if (!credentials.client_email || !credentials.private_key) return false;

  const key = credentials.private_key;
  return (
    key.includes('BEGIN PRIVATE KEY') &&
    key.includes('END PRIVATE KEY')
  );
}

let authConfig;
const loadedCredentials = loadServiceAccountCredentials();

if (validateServiceAccountCredentials(loadedCredentials)) {
  authConfig = {
    credentials: loadedCredentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  };
  console.log('Google auth mode: SERVICE_ACCOUNT (env)');
} else {
  const serviceAccountPath = path.resolve('./service-account.json');
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      'Google service account not configured. Set SERVICE_ACCOUNT_JSON (or SERVICE_ACCOUNT_PRIVATE_KEY + SERVICE_ACCOUNT_CLIENT_EMAIL) or provide service-account.json'
    );
  }

  authConfig = {
    keyFile: serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  };
  console.log('Google auth mode: service-account.json');
}

const auth = new google.auth.GoogleAuth(authConfig);

const sheets = google.sheets({ version: 'v4', auth });

const googleAuthReady = auth.getClient()
  .then(() => console.log('✅ GoogleAuth client OK'))
  .catch(err => console.error('❌ GoogleAuth error', err));

async function verifyGoogleSheetsAccess() {
  await googleAuthReady;
  await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'spreadsheetId'
  });
}

// === TELEGRAM BOT ===
const bot = new Telegraf(BOT_TOKEN);

// Глобал алдаа баригч
bot.catch((err, ctx) => {
  console.error('Telegraf error:', err);
});

// === САЙЖРУУЛСАН STATE MANAGEMENT ===
class ChatState {
  constructor() {
    this.states = new Map(); // chatId -> { currentDate, processingLock }
  }

  getState(chatId) {
    if (!this.states.has(chatId)) {
      this.states.set(chatId, {
        currentDate: null,
        processingLock: false
      });
    }
    return this.states.get(chatId);
  }

  setDate(chatId, date) {
    const state = this.getState(chatId);
    state.currentDate = date;
  }

  getDate(chatId) {
    return this.getState(chatId).currentDate;
  }

  // Давхар мессеж боловсруулахаас сэргийлэх
  async withLock(chatId, fn) {
    const state = this.getState(chatId);

    while (state.processingLock) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    state.processingLock = true;
    try {
      return await fn();
    } finally {
      state.processingLock = false;
    }
  }
}

const chatState = new ChatState();

// === SHEETS LOCK МЕХАНИЗМ ===
class SheetsLock {
  constructor() {
    this.locked = false;
    this.queue = [];
  }

  async acquire() {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      resolve();
    } else {
      this.locked = false;
    }
  }

  async withLock(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const sheetsLock = new SheetsLock();

// === WHITELIST MIDDLEWARE ===
bot.use(async (ctx, next) => {
  const chatId = ctx.chat && ctx.chat.id ? String(ctx.chat.id) : null;
  if (!chatId) return;

  if (!ALLOWED_CHAT_IDS.includes(chatId)) {
    return; // зөвшөөрөгдөөгүй чат → дуугүй ignore
  }

  return next();
});

// === ТУСЛАХ ФУНКЦУУД ===

// № авах
function extractNumber(text) {
  const lines = text.split('\n').map(l => l.trim());
  const nonEmpty = lines.filter(l => l !== '');
  if (nonEmpty.length === 0) return '';
  const first = nonEmpty[0];
  const m = first.match(/^(\d+)[\.\)]?$/);
  return m && m[1] ? m[1] : '';
}

// Тайлбар — Назначение / Назначение платежа / Наз гэх мэт хэлбэр таних
function extractDescription(text) {
  const m = text.match(/Наз(?:начение(?:\s+платежа)?)?[:\s]+([\s\S]*?)Сумма:/i);
  if (m && m[1]) {
    return 'Назначение: ' + m[1].trim();
  }
  return text;
}

// "1", "1-3", "1,2,3", "3-6,8,9" → тоонуудын жагсаалт
function parseNumberList(str) {
  const numbers = new Set();
  for (const seg of str.split(',')) {
    const trimmed = seg.trim();
    const parts = trimmed.split('-');
    if (parts.length === 2 && parts[0] && parts[1]) {
      const from = parseInt(parts[0], 10);
      const to = parseInt(parts[1], 10);
      if (!isNaN(from) && !isNaN(to)) {
        for (let i = from; i <= to; i++) numbers.add(i);
      }
    } else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n)) numbers.add(n);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

// Оригинал мессеж дээр 👍 reaction дарах
async function reactLike(ctx) {
  try {
    const msgId = ctx.message?.message_id || ctx.channelPost?.message_id;
    const chatId = ctx.chat?.id;
    if (!msgId || !chatId) return;
    await ctx.telegram.callApi('setMessageReaction', {
      chat_id: chatId,
      message_id: msgId,
      reaction: [{ type: 'emoji', emoji: '👍' }]
    });
  } catch (e) {
    console.error('Reaction error:', e.message || e);
  }
}

// === SWIFT ТУСЛАХ ФУНКЦУУД ===

// SWIFT мессеж мөн эсэх
function isSwiftMessage(text) {
  return /Amount:/i.test(text) && (
    /Company name:/i.test(text) ||
    /Company account:/i.test(text) ||
    /SWIFT:/i.test(text)
  );
}

// Эхний мөрнөөс № авах: "1. ps global" → "1"
function extractSwiftNumber(text) {
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l !== '') || '';
  const m = firstLine.match(/^(\d+)[\.\)]?\s*/);
  return m ? m[1] : '';
}

// Эхний мөрнөөс гүйцэтгэгч авах: "1. ps global" → "ps global"
function extractSwiftExecutor(text) {
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l !== '') || '';
  const m = firstLine.match(/^\d+[\.\)]?\s+(.*)/);
  return m ? m[1].trim() : '';
}

// Amount болон валют parse хийх
// Дэмжих форматууд: 21.000.000 jpy / 21,000,000 jpy / 1100 CNY г.м
function extractSwiftAmountAndCurrency(text) {
  const m = text.match(/Amount:\s*([\d\s,\.]+)\s+([a-zA-Z]+)/i);
  if (!m) return { amount: '', currency: '' };

  let amountStr = m[1].trim();
  const currency = m[2].trim().toUpperCase();

  // Бүх цэг, таслал, зайг хасна (бүгдийг мянгын тусгаарлагч гэж үзнэ)
  amountStr = amountStr.replace(/[\s,\.]/g, '');
  const num = parseFloat(amountStr);

  return { amount: isNaN(num) ? '' : num, currency };
}

// SWIFT мөр нэмэх
async function appendSwiftRow(number, fullText, executor, amount, currency) {
  return await sheetsLock.withLock(async () => {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SWIFT_SHEET_NAME}!A:H`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[number, fullText, executor, amount, currency, '', '', '']]
      }
    });
    invalidateCache();
  });
}

// Зарлагын дүн
function extractAmountForExpense(text) {
  const m = text.match(/Сумма:\s*([\d\s\.,]+)/i);
  if (!m) return '';
  let s = m[1].trim();
  s = s.replace(/\s+/g, '');
  s = s.replace(/,/g, '');
  const num = parseFloat(s);
  return isNaN(num) ? '' : num;
}

// Бүх мөрийг авах - CACHE-ТЭЙГЭЭР
let rowsCache = null;
let cacheTime = 0;
const CACHE_DURATION = 2000; // 2 секунд

async function getAllRows(useCache = true) {
  const now = Date.now();

  if (useCache && rowsCache && (now - cacheTime) < CACHE_DURATION) {
    return rowsCache;
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:G`
  });

  rowsCache = res.data.values || [];
  cacheTime = now;

  return rowsCache;
}

// Cache-ийг устгах
function invalidateCache() {
  rowsCache = null;
  cacheTime = 0;
}

// Мөр нэмэх - LOCK-ТЭЙГЭЭР
async function appendTransactionRow(date, number, description, amount) {
  return await sheetsLock.withLock(async () => {
    const timestamp = new Date().toISOString();

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[number, date, description, amount, '', timestamp, '']]
      }
    });

    invalidateCache();
  });
}

// Огноо + дугаарын жагсаалтаар өртөг ханш шинэчлэх
async function updateRateForDate(date, rate, numberList = null) {
  return await sheetsLock.withLock(async () => {
    const rows = await getAllRows(false); // fresh data
    if (rows.length < 2) return 0;

    const updates = [];
    const numberSet = numberList ? new Set(numberList) : null;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowDate = row[1];
      const currentRate = row[4];

      if (rowDate !== date) continue;
      if (currentRate && currentRate !== '') continue; // зөвхөн хоосон E

      if (numberSet !== null) {
        const no = parseInt(row[0], 10);
        if (isNaN(no) || !numberSet.has(no)) continue;
      }

      const rowIndex = i + 1;
      updates.push({
        range: `${SHEET_NAME}!E${rowIndex}`,
        values: [[rate]]
      });
    }

    if (updates.length === 0) return 0;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates
      }
    });

    invalidateCache();
    return updates.length;
  });
}

// === КОМАНДУУД ===

// /version команд — шинэчлэгдсэн эсэхийг шалгах
bot.command('version', (ctx) => {
  ctx.reply('✅ v2.0 — 2026.04.23\nШинэ /start заавар, алдааны дэлгэрэнгүй мэдэгдэл, 👍 reaction засвар.');
});

// /start команд
bot.start((ctx) => {
  const text =
    '<b>OYUNS BOT — Заавар</b>\n\n' +

    '━━━━━━━━━━━━━━━━━━━\n' +
    '<b>1. Огноо тохируулах</b>\n' +
    'Эхлээд өдрийн огноог оруулна уу:\n' +
    '<code>2025.12.05 FRIDAY</code>\n' +
    '<i>(Үүнгүйгээр гүйлгээ бүртгэхгүй)</i>\n\n' +

    '━━━━━━━━━━━━━━━━━━━\n' +
    '<b>2. Ердийн гүйлгээ бүртгэх</b>\n' +
    '<code>1. Компани нэр\n' +
    'Наз: Барааны тооцоо\n' +
    'Сумма: 500000</code>\n' +
    '<i>→ Transactions sheet-д хадгалагдана</i>\n\n' +

    '━━━━━━━━━━━━━━━━━━━\n' +
    '<b>3. SWIFT гүйлгээ бүртгэх</b>\n' +
    '<code>1. PS Global\n' +
    'Amount: 1,500,000 JPY\n' +
    'SWIFT: XXXXXXXX\n' +
    'Company name: Example Ltd</code>\n' +
    '<i>→ SWIFT sheet-д хадгалагдана</i>\n\n' +

    '━━━━━━━━━━━━━━━━━━━\n' +
    '<b>4. Өртөг ханш тохируулах</b>\n' +
    '<code>Өртөг ханш 3.45</code>  — бүгдэд\n' +
    '<code>Өртөг ханш 1-3: 3.45</code>  — 1-3 мөрд\n' +
    '<code>Өртөг ханш 1,2,5: 3.45</code>  — сонгосон мөрд\n\n' +

    '━━━━━━━━━━━━━━━━━━━\n' +
    '<b>5. Тойм харах</b>\n' +
    '<code>/general</code>  — өнөөдрийн тойм\n' +
    '<code>/general 2025.12.05</code>  — тухайн өдрийн тойм\n\n' +

    '━━━━━━━━━━━━━━━━━━━\n' +
    '💡 <i>Амжилттай бүртгэгдсэн үед 👍 реакц өгнө</i>\n' +
    '💡 <i>Зураг/файлын caption дээр ч мөн ажиллана</i>';

  ctx.reply(text, { parse_mode: 'HTML' });
});

// /loading
bot.command('loading', async (ctx) => {
  try {
    const rows = await getAllRows();
    if (rows.length < 2) {
      await ctx.reply('Одоогоор гүйлгээ алга.');
      return;
    }

    const pending = rows.slice(1).filter((r) => {
      const status = r[6] || '';
      return !status || status === 'Хүлээгдэж буй';
    });

    if (pending.length === 0) {
      await ctx.reply('Хүлээгдэж буй гүйлгээ алга 🎉');
      return;
    }

    let msg = '<b>МНТ хүлээгдэж буй гүйлгээнүүд:</b>\n\n';
    pending.forEach((r, idx) => {
      const no = r[0] || '';
      const date = r[1] || '';
      const desc = (r[2] || '').substring(0, 80);
      const amount = r[3] || '';
      msg += `${idx + 1}) №${no} | ${date} | ${amount}\n${desc}\n\n`;
    });

    await ctx.reply(msg, { parse_mode: 'HTML' });
  } catch (err) {
    console.error(err);
    await ctx.reply('Алдаа гарлаа /loading дээр 😢');
  }
});

// /successful [огноо]
bot.command('successful', async (ctx) => {
  try {
    const chatId = String(ctx.chat.id);

    const args = ctx.message.text.split(/\s+/).slice(1);
    let targetDate;

    if (args.length > 0) {
      targetDate = args[0].replace(/-/g, '.');
    } else {
      targetDate = chatState.getDate(chatId);
    }

    if (!targetDate) {
      await ctx.reply('Огноо оруулна уу. Жишээ: /successful 2025.12.05');
      return;
    }

    const rows = await getAllRows();
    if (rows.length < 2) {
      await ctx.reply('Одоогоор гүйлгээ алга.');
      return;
    }

    const ok = rows.slice(1).filter((r) => {
      const date = r[1] || '';
      const status = r[6] || '';
      return date === targetDate && status === 'Амжилттай';
    });

    if (ok.length === 0) {
      await ctx.reply(`Амжилттай гүйлгээ алга. Огноо: ${targetDate}`);
      return;
    }

    let msg = `<b>Амжилттай гүйлгээнүүд (${targetDate}):</b>\n\n`;
    ok.forEach((r, idx) => {
      const no = r[0] || '';
      const date = r[1] || '';
      const desc = (r[2] || '').substring(0, 80);
      const amount = r[3] || '';
      msg += `${idx + 1}) №${no} | ${date} | ${amount}\n${desc}\n\n`;
    });

    await ctx.reply(msg, { parse_mode: 'HTML' });
  } catch (err) {
    console.error(err);
    await ctx.reply('Алдаа гарлаа /successful дээр 😢');
  }
});

// /canceled [огноо]
bot.command('canceled', async (ctx) => {
  try {
    const chatId = String(ctx.chat.id);

    const args = ctx.message.text.split(/\s+/).slice(1);
    let targetDate;

    if (args.length > 0) {
      targetDate = args[0].replace(/-/g, '.');
    } else {
      targetDate = chatState.getDate(chatId);
    }

    if (!targetDate) {
      await ctx.reply('Огноо оруулна уу. Жишээ: /canceled 2025.12.05');
      return;
    }

    const rows = await getAllRows();
    if (rows.length < 2) {
      await ctx.reply('Одоогоор гүйлгээ алга.');
      return;
    }

    const canceled = rows.slice(1).filter((r) => {
      const date = r[1] || '';
      const status = r[6] || '';
      return date === targetDate && status === 'Цуцласан';
    });

    if (canceled.length === 0) {
      await ctx.reply(`Цуцласан гүйлгээ алга. Огноо: ${targetDate}`);
      return;
    }

    let msg = `<b>Цуцласан гүйлгээнүүд (${targetDate}):</b>\n\n`;
    canceled.forEach((r, idx) => {
      const no = r[0] || '';
      const date = r[1] || '';
      const desc = (r[2] || '').substring(0, 80);
      const amount = r[3] || '';
      msg += `${idx + 1}) №${no} | ${date} | ${amount}\n${desc}\n\n`;
    });

    await ctx.reply(msg, { parse_mode: 'HTML' });
  } catch (err) {
    console.error(err);
    await ctx.reply('Алдаа гарлаа /canceled дээр 😢');
  }
});

// /general [огноо]
bot.command('general', async (ctx) => {
  try {
    const chatId = String(ctx.chat.id);

    const args = ctx.message.text.split(/\s+/).slice(1);
    let targetDate;

    if (args.length > 0) {
      targetDate = args[0].replace(/-/g, '.');
    } else {
      targetDate = chatState.getDate(chatId);
    }

    if (!targetDate) {
      await ctx.reply('Огноо оруулна уу. Жишээ: /general 2025.12.05');
      return;
    }

    const rows = await getAllRows();
    if (rows.length < 2) {
      await ctx.reply('Одоогоор гүйлгээ алга.');
      return;
    }

    let success = 0;
    let pending = 0;
    let canceled = 0;

    rows.slice(1).forEach((r) => {
      const date = r[1] || '';
      if (date !== targetDate) return;

      const status = r[6] || '';
      if (status === 'Амжилттай') success++;
      else if (status === 'Цуцласан') canceled++;
      else pending++;
    });

    const total = success + pending + canceled;
    if (total === 0) {
      await ctx.reply(`Тухайн огноонд гүйлгээ алга. Огноо: ${targetDate}`);
      return;
    }

    const msg =
      `<b>Гүйлгээний тойм (${targetDate}):</b>\n\n` +
      `✅ Амжилттай: ${success}\n` +
      `⌛ Хүлээгдэж буй: ${pending}\n` +
      `❌ Цуцласан: ${canceled}\n`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
  } catch (err) {
    console.error(err);
    await ctx.reply('Алдаа гарлаа /general дээр 😢');
  }
});

// === МЕССЕЖ БОЛОВСРУУЛАХ ФУНКЦ ===
async function processMessage(ctx, text) {
  const chatId = String(ctx.chat.id);

  return await chatState.withLock(chatId, async () => {
    // 1) ОГНОО МЕССЕЖ ҮҮ?
    const dateMatch = text.match(/^\s*(\d{4}[.\-]\d{2}[.\-]\d{2})(?:\s+\S+)?\s*$/);
    if (dateMatch) {
      const datePart = dateMatch[1].replace(/-/g, '.');
      chatState.setDate(chatId, datePart);
      await reactLike(ctx);
      return true;
    }

    const currentDate = chatState.getDate(chatId);

    // 2) SWIFT МЕССЕЖ ҮҮ?
    if (isSwiftMessage(text)) {
      const number = extractSwiftNumber(text);
      const executor = extractSwiftExecutor(text);
      const { amount, currency } = extractSwiftAmountAndCurrency(text);

      await appendSwiftRow(number, text, executor, amount, currency);
      await reactLike(ctx);
      return true;
    }

    // 3) ГҮЙЛГЭЭ (НАЗНАЧЕНИЕ) МЕССЕЖ ҮҮ?
    const hasPurpose = /Наз(?:начение(?:\s+платежа)?)?[\s:]/i.test(text);
    const hasAmount = /Сумма:/i.test(text);

    if (hasPurpose && hasAmount) {
      if (!currentDate) {
        await ctx.reply('Эхлээд огноо оруулна уу. Жишээ: 2025.12.05 FRIDAY');
        return true;
      }

      const number = extractNumber(text);
      const description = extractDescription(text);
      const amount = extractAmountForExpense(text);

      await appendTransactionRow(currentDate, number, description, amount);

      await reactLike(ctx);
      return true;
    }

    // 4) ӨРТӨГ ХАНШ МЕССЕЖ ҮҮ?
    if (text.startsWith('Өртөг ханш')) {
      if (!currentDate) {
        await ctx.reply('Эхлээд огноо оруулна уу.');
        return true;
      }

      // Формат: Өртөг ханш [дугаарууд]: [ханш]
      // Дугаарууд: 1 / 1-3 / 1,2,3 / 3-6,8,9 г.м
      let numberList = null;
      let rateStr = null;

      const rangeMatch = text.match(/Өртөг ханш[:\s]+([\d][\d,\-]*)\s*:\s*([\d\.,]+)/i);
      const rateOnlyMatch = text.match(/Өртөг ханш[:\s]+([\d\.,]+)/i);

      if (rangeMatch) {
        numberList = parseNumberList(rangeMatch[1]);
        rateStr = rangeMatch[2];
      } else if (rateOnlyMatch) {
        rateStr = rateOnlyMatch[1];
      }

      if (!rateStr) {
        await ctx.reply('Зөв формат: Өртөг ханш: 46,40 эсвэл Өртөг ханш: 1-3,5: 46,40');
        return true;
      }

      rateStr = rateStr.replace(/\s+/g, '').replace(',', '.');

      await updateRateForDate(currentDate, rateStr, numberList);

      await reactLike(ctx);
      return true;
    }

    return false;
  });
}

// === ТЕКСТ МЕССЕЖ ===
bot.on('text', async (ctx, next) => {
  try {
    const text = ctx.message.text.trim();

    if (text.startsWith('/')) {
      return next();
    }

    await processMessage(ctx, text);
  } catch (err) {
    console.error('Error in text handler:', err?.message || err);
    try {
      await ctx.reply(`Дотоод алдаа гарлаа 😢\n<code>${err?.message || 'Unknown error'}</code>`, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
});

// === ЗУРАГТАЙ (PHOTO) МЕССЕЖ ===
bot.on('photo', async (ctx) => {
  try {
    const caption = (ctx.message.caption || '').trim();
    if (!caption) return;
    await processMessage(ctx, caption);
  } catch (err) {
    console.error('Error in photo handler:', err?.message || err);
    try {
      await ctx.reply(`Дотоод алдаа гарлаа (photo) 😢\n<code>${err?.message || 'Unknown error'}</code>`, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
});

// === ФАЙЛТАЙ (DOCUMENT) МЕССЕЖ ===
bot.on('document', async (ctx) => {
  try {
    const caption = (ctx.message.caption || '').trim();
    if (!caption) return;
    await processMessage(ctx, caption);
  } catch (err) {
    console.error('Error in document handler:', err);
    try {
      await ctx.reply('Дотоод алдаа гарлаа (document) 😢');
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
});

// === HTTP SERVER (Render-д зориулсан) ===
const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  if (req.url === '/health') {
    try {
      await verifyGoogleSheetsAccess();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, status: 'healthy' }));
    } catch (err) {
      const message = err?.message || 'Unknown error';
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        status: 'unhealthy',
        error: message
      }));
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('OYUNS bot is running ✅\n');
}).listen(PORT, () => {
  console.log('HTTP server listening on port', PORT);
});

// === БОТЫГ АСГАХ ===
(async () => {
  try {
    await bot.launch();
    console.log('Bot started...');
  } catch (err) {
    console.error('Bot launch error:', err);
    process.exit(1);
  }
})();

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('SIGINT received, stopping bot...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('SIGTERM received, stopping bot...');
  bot.stop('SIGTERM');
});
