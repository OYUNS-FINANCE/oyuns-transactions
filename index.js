const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const path = require('path');
const http = require('http');

// === ЗӨВШӨӨРӨГДСӨН ЧАТУУД (WHITELIST) ===
const ALLOWED_CHAT_IDS = [
  '1920453419',
  '1447446407',
  '-1003019837728'
];

// === ТОХИРУУЛГА ===
const BOT_TOKEN = '8108084322:AAEfmQq8uxTlE0L9t3SOQOlIIzQmZ8JwAdI';
const SPREADSHEET_ID = '1qbxJsI4Ns3a8lluxlRZl5r5AKHA3hp9yS7YZLwY469A';
const SHEET_NAME = 'Transactions';
const SWIFT_SHEET_NAME = 'SWIFT';

// === GOOGLE SHEETS AUTH ===
const credentialsPath = path.resolve('./service-account.json');

const auth = new google.auth.GoogleAuth({
  keyFile: credentialsPath,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

auth.getClient()
  .then(() => console.log('✅ GoogleAuth client OK'))
  .catch(err => console.error('❌ GoogleAuth error', err));

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
    await ctx.telegram.callApi('setMessageReaction', {
      chat_id: ctx.chat.id,
      message_id: ctx.message.message_id,
      reaction: [{ type: 'emoji', emoji: '👍' }]
    });
  } catch (e) {
    console.error('Reaction error:', e);
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

// /start команд
bot.start((ctx) => {
  const text =
    'Сайн уу! 😊\n\n' +
    'Эхлээд огноо оруулна уу.\n\n' +
    'Дараа нь гүйлгээ бүрийг ийм хэлбэрээр явуулна:\n\n' +
    '<i>1.\n' +
    'Назначение: ...\n' +
    'Сумма: ... руб</i>\n\n' +
    'Сүүлд нь:\n' +
    '<i>Өртөг ханш: ...</i>';

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
    console.error('Error in text handler:', err);
    try {
      await ctx.reply('Дотоод алдаа гарлаа 😢');
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
    console.error('Error in photo handler:', err);
    try {
      await ctx.reply('Дотоод алдаа гарлаа (photo)');
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

http.createServer((req, res) => {
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
