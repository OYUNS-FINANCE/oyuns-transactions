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
// Чат бүрд хадгалах мэдээлэл
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

  // Processing lock - давхар мессеж боловсруулахаас сэргийлэх
  async withLock(chatId, fn) {
    const state = this.getState(chatId);
    
    // Хэрэв аль хэдийн боловсруулж байгаа бол хүлээнэ
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
// Нэгэн зэрэг олон бичилт хийхээс сэргийлэх
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

// Тайлбар
function extractDescription(text) {
  const m = text.match(/Назначение:\s*([\s\S]*?)Сумма:/i);
  if (m && m[1]) {
    return 'Назначение: ' + m[1].trim();
  }
  return text;
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
async function appendTransactionRow(date, number, description, amount, status = 'Хүлээгдэж буй') {
  return await sheetsLock.withLock(async () => {
    const timestamp = new Date().toISOString();

    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[number, date, description, amount, '', timestamp, status]]
      }
    });

    invalidateCache();

    let rowIndex = null;
    const updates = res.data && res.data.updates;
    if (updates && updates.updatedRange) {
      const m = updates.updatedRange.match(/![A-Z]+(\d+):/);
      if (m && m[1]) {
        rowIndex = parseInt(m[1], 10);
      }
    }

    // Fallback: хэрвээ updatedRange байхгүй бол A баганын мөрийн тоогоор rowIndex тодорхойлно
    if (!rowIndex) {
      try {
        const rowsRes = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A:A`
        });
        const rows = rowsRes.data.values || [];
        rowIndex = rows.length; // header + бүх мөр
        console.log(`⚠️ Fallback: rowIndex = ${rowIndex}`);
      } catch (err) {
        console.error('Error in fallback rowIndex calculation:', err);
      }
    }

    return rowIndex;
  });
}

// Огноо таарч байгаа мөрүүдийн E баганад ханш бичих
async function updateRateForDate(date, rate) {
  return await sheetsLock.withLock(async () => {
    const rows = await getAllRows(false); // fresh data
    if (rows.length < 2) return;

    const updates = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowDate = row[1];
      const currentRate = row[4];
      if (rowDate === date && (!currentRate || currentRate === '')) {
        const rowIndex = i + 1;
        updates.push({
          range: `${SHEET_NAME}!E${rowIndex}`,
          values: [[rate]]
        });
      }
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

// Статус бичих
async function updateStatus(rowIndex, statusText) {
  if (!rowIndex) return;
  
  return await sheetsLock.withLock(async () => {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!G${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[statusText]]
      }
    });
    
    invalidateCache();
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
    
    // Командын дараах текст авах
    const args = ctx.message.text.split(/\s+/).slice(1);
    let targetDate;
    
    if (args.length > 0) {
      // Огноо командын дараа байвал түүнийг ашиглах
      targetDate = args[0].replace(/-/g, '.');
    } else {
      // Огноо байхгүй бол сүүлийн тохируулсан огноо ашиглах
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
    
    // Командын дараах текст авах
    const args = ctx.message.text.split(/\s+/).slice(1);
    let targetDate;
    
    if (args.length > 0) {
      // Огноо командын дараа байвал түүнийг ашиглах
      targetDate = args[0].replace(/-/g, '.');
    } else {
      // Огноо байхгүй бол сүүлийн тохируулсан огноо ашиглах
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
    
    // Командын дараах текст авах
    const args = ctx.message.text.split(/\s+/).slice(1);
    let targetDate;
    
    if (args.length > 0) {
      // Огноо командын дараа байвал түүнийг ашиглах
      targetDate = args[0].replace(/-/g, '.');
    } else {
      // Огноо байхгүй бол сүүлийн тохируулсан огноо ашиглах
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
      await ctx.reply(`Огноо тогтоож авлаа: ${datePart}`);
      return true;
    }

    const currentDate = chatState.getDate(chatId);

    // 2) ГҮЙЛГЭЭ МЕССЕЖ ҮҮ?
    const hasPurpose = /Назначение:/i.test(text);
    const hasAmount = /Сумма:/i.test(text);

    if (hasPurpose && hasAmount) {
      if (!currentDate) {
        await ctx.reply('Эхлээд огноо оруулна уу. Жишээ: 2025.12.05 FRIDAY');
        return true;
      }

      const number = extractNumber(text);
      const description = extractDescription(text);
      const amount = extractAmountForExpense(text);

      const rowIndex = await appendTransactionRow(currentDate, number, description, amount);

      await ctx.reply(`Гүйлгээг бүртгэлээ.\n\n${text}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅', callback_data: `status:SUCCESS:${rowIndex}` },
              { text: '❌', callback_data: `status:CANCELED:${rowIndex}` }
            ]
          ]
        }
      });
      return true;
    }

   // 3) ӨРТӨГ ХАНШ — ДЭЭРХ №-Д ТУСГАЙ ХАНШ ОНООХ
if (text.startsWith('Өртөг ханш')) {
  if (!currentDate) {
    await ctx.reply('Эхлээд огноо оруулна уу.');
    return true;
  }

  /*
    3 формат дэмжинэ:
    1) Өртөг ханш: 46.10
    2) Өртөг ханш: 3-6: 46.10
    3) Өртөг ханш: 1-2: 45.80
  */

  // 3-6: 46.10 гэх мэт эсэхийг шалгах
  const rangeMatch = text.match(/Өртөг ханш[:\s]+(\d+)\s*-\s*(\d+)\s*[:\s]+([\d\.,]+)/i);
  
  if (rangeMatch) {
    const startNo = parseInt(rangeMatch[1]);
    const endNo = parseInt(rangeMatch[2]);
    let rate = rangeMatch[3].replace(',', '.');

    const rows = await getAllRows(false);
    const updates = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const date = row[1];
      const no = parseInt(row[0]);

      if (date === currentDate && no >= startNo && no <= endNo) {
        const rowIndex = i + 1;
        updates.push({
          range: `${SHEET_NAME}!E${rowIndex}`,
          values: [[rate]]
        });
      }
    }

    if (updates.length === 0) {
      await ctx.reply(`Тухайн огноонд №${startNo}-${endNo} гүйлгээ олдсонгүй.`);
      return true;
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates
      }
    });

    invalidateCache();

    await ctx.reply(`Өртөг ханш №${startNo}-${endNo} гүйлгээд ${rate} гэж тохирууллаа. ✅`);
    return true;
  }

  // Энгийн формат: Өртөг ханш: 46.10
  const simpleMatch = text.match(/Өртөг ханш[:\s]+([\d\.,]+)/i);
  if (simpleMatch) {
    let rate = simpleMatch[1].replace(',', '.');
    const updated = await updateRateForDate(currentDate, rate);
    await ctx.reply(`Өртөг ханш ${rate} гэж бүх гүйлгээд тохирууллаа (${updated} мөр) ✅`);
    return true;
  }

  await ctx.reply('❗ Зөв формат: \nӨртөг ханш: 46.10 \nэсвэл\nӨртөг ханш: 3-6: 46.10');
  return true;
}

// === ТЕКСТ МЕССЕЖ ===
bot.on('text', async (ctx, next) => {
  try {
    const text = ctx.message.text.trim();

    // Комманд байвал -> дараагийн handler руу
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
      await ctx.reply('Дотоод алдаа гарлаа (photo) 😢');
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
});

// === INLINE ТОВЧ (✅ / ❌) ===
bot.on('callback_query', async (ctx) => {
  try {
    const data = ctx.callbackQuery.data || '';
    if (!data.startsWith('status:')) {
      await ctx.answerCbQuery();
      return;
    }

    const parts = data.split(':');
    const statusKey = parts[1];
    const rowIndex = parseInt(parts[2], 10);

    let statusText;
    if (statusKey === 'SUCCESS') statusText = 'Амжилттай';
    else if (statusKey === 'CANCELED') statusText = 'Цуцласан';
    else statusText = 'Хүлээгдэж буй';

    await updateStatus(rowIndex, statusText);

    await ctx.answerCbQuery(`Статус: ${statusText}`);

    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch (e) {
      // Товчийг устгаж чадахгүй бол дуугүй үргэлжлүүлнэ
    }

    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Мессежийг устгаж чадахгүй бол дуугүй үргэлжлүүлнэ
    }
  } catch (err) {
    console.error('Error in callback_query:', err);
    try {
      await ctx.answerCbQuery('Алдаа гарлаа 😢', { show_alert: true });
    } catch (e) {
      console.error('Failed to send callback error:', e);
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