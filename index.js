const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const path = require('path');
const http = require('http'); // Render-д зориулсан жижиг HTTP server

// === ЗӨВШӨӨРӨГДСӨН ЧАТУУДЫН ЖАГСААЛТ (WHITELIST) ====
// Анужин хувийн чат: 1920453419
// Группийн chat ID: -1003019837728
const ALLOWED_CHAT_IDS = [
  '1920453419',
  '1447446407',
  '-1003019837728',
];

// === ТОХИРУУЛГА ===
const BOT_TOKEN = '8108084322:AAEfmQq8uxTlE0L9t3SOQOlIIzQmZ8JwAdI';
const SPREADSHEET_ID = '1qbxJsI4Ns3a8lluxlRZl5r5AKHA3hp9yS7YZLwY469A';
const SHEET_NAME = 'Transactions';
// A:№, B:Огноо, C:Тайлбар, D:Дүн, E:Өртөг ханш, F:Timestamp, G:Статус

// === GOOGLE SHEETS AUTH ===
const credentialsPath = path.resolve('./service-account.json');

const auth = new google.auth.GoogleAuth({
  keyFile: credentialsPath,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
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

// Чат бүрийн төлөв
const state = {
  currentDate: {}, // chatId -> date string (2025.12.05)
};

// === WHITELIST MIDDLEWARE (НИЙТД НЭГ УДАА) ===
bot.use(async (ctx, next) => {
  const chatId = ctx.chat && ctx.chat.id ? String(ctx.chat.id) : null;
  if (!chatId) return;

  if (!ALLOWED_CHAT_IDS.includes(chatId)) {
    // зөвшөөрөгдөөгүй чат → дуугүй ignore
    return;
  }

  return next();
});

// === ТУСЛАХ ФУНКЦУУД ===

// № авах — эхний хоосон биш мөрөөс (жишээ: "1." эсвэл "1)")
function extractNumber(text) {
  const lines = text.split('\n').map(l => l.trim());
  const nonEmpty = lines.filter(l => l !== '');
  if (nonEmpty.length === 0) return '';
  const first = nonEmpty[0]; // ж: "3." эсвэл "3)"
  const m = first.match(/^(\d+)[\.\)]?$/);
  return m && m[1] ? m[1] : '';
}

// Тайлбар: зөвхөн "Назначение: ..."-ийн хэсэг, "Сумма:"-аас өмнө хүртэл
function extractDescription(text) {
  const m = text.match(/Назначение:\s*([\s\S]*?)Сумма:/i);
  if (m && m[1]) {
    return 'Назначение: ' + m[1].trim();
  }
  return text;
}

// Зарлагын дүн: "Сумма: 3,315,696.00 руб" → 3315696.00 (тоо хэлбэрээр)
function extractAmountForExpense(text) {
  const m = text.match(/Сумма:\s*([\d\s\.,]+)/i);
  if (!m) return '';
  let s = m[1].trim();
  s = s.replace(/\s+/g, '');  // бүх зай
  s = s.replace(/,/g, '');    // бүх комма-г авна → 3315696.00
  const num = parseFloat(s);
  return isNaN(num) ? '' : num;
}

// Бүх мөрийг авах
async function getAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:G`,
  });
  const rows = res.data.values || [];
  return rows;
}

// Мөр нэмэх (default статус: Хүлээгдэж буй), ЯГ БОДИТ rowIndex-ийг буцаана
async function appendTransactionRow(date, number, description, amount, status = 'Хүлээгдэж буй') {
  const timestamp = new Date().toISOString();

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[number, date, description, amount, '', timestamp, status]],
    },
  });

  // Google Sheets API буцааж өгдөг range-ээс мөрийн дугаар авах (ж: 'Transactions!A15:G15')
  let rowIndex = null;
  const updates = res.data && res.data.updates;
  if (updates && updates.updatedRange) {
    const m = updates.updatedRange.match(/![A-Z]+(\d+):/);
    if (m && m[1]) {
      rowIndex = parseInt(m[1], 10);
    }
  }

  return rowIndex;
}

// Огноо таарч байгаа мөрүүдийн E баганад ханш бичих (хоосон байвал)
async function updateRateForDate(date, rate) {
  const rows = await getAllRows();
  if (rows.length < 2) return; // зөвхөн header байвал

  const updates = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowDate = row[1];     // B багана (Огноо)
    const currentRate = row[4]; // E багана (Өртөг ханш)
    if (rowDate === date && (!currentRate || currentRate === '')) {
      const rowIndex = i + 1; // 1-based
      updates.push({
        range: `${SHEET_NAME}!E${rowIndex}`,
        values: [[rate]],
      });
    }
  }

  if (updates.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates,
    },
  });
}

// G баганад статус бичих (Амжилттай / Хүлээгдэж буй / Цуцласан)
async function updateStatus(rowIndex, statusText) {
  if (!rowIndex) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!G${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[statusText]],
    },
  });
}

// === КОМАНДУУД: /start, /loading, /successful, /canceled, /general ===

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

// /loading — Хүлээгдэж буй гүйлгээнүүд (БҮХ өдөр)
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

    let msg = '<b>Хүлээгдэж буй гүйлгээнүүд:</b>\n\n';
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

// /successful — тухайн огнооны амжилттай гүйлгээнүүд
bot.command('successful', async (ctx) => {
  try {
    const chatId = String(ctx.chat.id);
    const currentDate = state.currentDate[chatId];

    if (!currentDate) {
      await ctx.reply(
        'Эхлээд ямар огнооны гүйлгээг харахаа оруулна уу. Жишээ: 2025.12.05 FRIDAY',
      );
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
      return date === currentDate && status === 'Амжилттай';
    });

    if (ok.length === 0) {
      await ctx.reply(`Амжилттай гүйлгээ алга. Огноо: ${currentDate}`);
      return;
    }

    let msg = `<b>Амжилттай гүйлгээнүүд (${currentDate}):</b>\n\n`;
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

// /canceled — тухайн огнооны цуцалсан гүйлгээнүүд
bot.command('canceled', async (ctx) => {
  try {
    const chatId = String(ctx.chat.id);
    const currentDate = state.currentDate[chatId];

    if (!currentDate) {
      await ctx.reply(
        'Эхлээд ямар огнооны гүйлгээг харахаа оруулна уу. Жишээ: 2025.12.05 FRIDAY',
      );
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
      return date === currentDate && status === 'Цуцласан';
    });

    if (canceled.length === 0) {
      await ctx.reply(`Цуцласан гүйлгээ алга. Огноо: ${currentDate}`);
      return;
    }

    let msg = `<b>Цуцласан гүйлгээнүүд (${currentDate}):</b>\n\n`;
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

// /general — тухайн огнооны тойм
bot.command('general', async (ctx) => {
  try {
    const chatId = String(ctx.chat.id);
    const currentDate = state.currentDate[chatId];

    if (!currentDate) {
      await ctx.reply(
        'Эхлээд ямар огнооны тоймыг харахоо оруулна уу. Жишээ: 2025.12.05 FRIDAY',
      );
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
      if (date !== currentDate) return;

      const status = r[6] || '';
      if (status === 'Амжилттай') success++;
      else if (status === 'Цуцласан') canceled++;
      else pending++; // хоосон эсвэл "Хүлээгдэж буй"
    });

    const total = success + pending + canceled;
    if (total === 0) {
      await ctx.reply(`Тухайн огноонд гүйлгээ алга. Огноо: ${currentDate}`);
      return;
    }

    const msg =
      `<b>Гүйлгээний тойм (${currentDate}):</b>\n\n` +
      `✅ Амжилттай: ${success}\n` +
      `⌛ Хүлээгдэж буй: ${pending}\n` +
      `❌ Цуцласан: ${canceled}\n`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
  } catch (err) {
    console.error(err);
    await ctx.reply('Алдаа гарлаа /general дээр 😢');
  }
});

// === ТЕКСТ МЕССЕЖ (ОГНОО, ГҮЙЛГЭЭ, ХАНШ) ===
bot.on('text', async (ctx, next) => {
  try {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text.trim();

    // Хэрвээ команд байвал (/loading, /general г.м) -> цааш дамжуулна
    if (text.startsWith('/')) {
      return next();
    }

    // 1) ОГНОО МЕССЕЖ ҮҮ? (2025.12.05 FRIDAY)
    const dateMatch = text.match(/^\s*(\d{4}[.\-]\d{2}[.\-]\d{2})(?:\s+\S+)?\s*$/);
    if (dateMatch) {
      const datePart = dateMatch[1].replace(/-/g, '.'); // 2025-12-05 -> 2025.12.05
      state.currentDate[chatId] = datePart;
      await ctx.reply(`Огноо тогтоож авлаа: ${datePart}`);
      return;
    }

    const currentDate = state.currentDate[chatId];

    // 2) ГҮЙЛГЭЭ МЕССЕЖ ҮҮ? ("Назначение:" + "Сумма:" хоёулаа байх ёстой)
    const hasPurpose = /Назначение:/i.test(text);
    const hasAmount = /Сумма:/i.test(text);

    if (hasPurpose && hasAmount) {
      if (!currentDate) {
        await ctx.reply('Эхлээд огноо оруулна уу. Жишээ: 2025.12.05 FRIDAY');
        return;
      }

      const number = extractNumber(text); // 1., 2), 3 гэх мэт
      const description = extractDescription(text); // Назначение: ... (Сумма хүртэл)
      const amount = extractAmountForExpense(text); // 3,315,696.00 -> 3315696.00

      const rowIndex = await appendTransactionRow(
        currentDate,
        number,
        description,
        amount,
      );

      await ctx.reply(`Гүйлгээг бүртгэлээ.\n\n${text}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅', callback_data: `status:SUCCESS:${rowIndex}` },
              { text: '❌', callback_data: `status:CANCELED:${rowIndex}` },
            ],
          ],
        },
      });
      return;
    }

    // 3) ӨРТӨГ ХАНШ МЕССЕЖ ҮҮ?
    if (text.startsWith('Өртөг ханш')) {
      if (!currentDate) {
        await ctx.reply('Эхлээд огноо оруулна уу.');
        return;
      }

      const rateMatch = text.match(/Өртөг ханш[:\s]+([\d\.,]+)/i);
      if (!rateMatch) {
        await ctx.reply('Зөв формат: Өртөг ханш: 46,40');
        return;
      }

      let rateStr = rateMatch[1].replace(/\s+/g, '').replace(',', '.');
      await updateRateForDate(currentDate, rateStr);
      await ctx.reply(`Өртөг ханш ${rateStr} гэж тохирууллаа ✅`);
      return;
    }

    // 4) БУСАД МЕССЕЖ → үл тооно
    return;
  } catch (err) {
    console.error(err);
    try {
      await ctx.reply('Дотоод алдаа гарлаа 😢');
    } catch (e) {}
  }
});

// === ЗУРАГТАЙ (PHOTO) МЕССЕЖИЙН CAPTION-ЫГ БАС АЖИЛЛУУЛНА ===
bot.on('photo', async (ctx) => {
  try {
    const chatId = String(ctx.chat.id);
    const caption = (ctx.message.caption || '').trim();

    if (!caption) return;

    // 1) ОГНОО CAPTION ҮҮ? (2025.12.05 FRIDAY)
    const dateMatch = caption.match(/^\s*(\d{4}[.\-]\d{2}[.\-]\d{2})(?:\s+\S+)?\s*$/);
    if (dateMatch) {
      const datePart = dateMatch[1].replace(/-/g, '.');
      state.currentDate[chatId] = datePart;
      await ctx.reply(`Огноо тогтоож авлаа: ${datePart}`);
      return;
    }

    const currentDate = state.currentDate[chatId];

    // 2) ГҮЙЛГЭЭ CAPTION ҮҮ? ("Назначение:" + "Сумма:")
    const hasPurpose = /Назначение:/i.test(caption);
    const hasAmount = /Сумма:/i.test(caption);

    if (hasPurpose && hasAmount) {
      if (!currentDate) {
        await ctx.reply('Эхлээд огноо оруулна уу. Жишээ: 2025.12.05 FRIDAY');
        return;
      }

      const number = extractNumber(caption);
      const description = extractDescription(caption);
      const amount = extractAmountForExpense(caption);

      const rowIndex = await appendTransactionRow(
        currentDate,
        number,
        description,
        amount,
      );

      await ctx.reply(`Гүйлгээг бүртгэлээ (зурагтай).\n\n${caption}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅', callback_data: `status:SUCCESS:${rowIndex}` },
              { text: '❌', callback_data: `status:CANCELED:${rowIndex}` },
            ],
          ],
        },
      });
      return;
    }

    // 3) ӨРТӨГ ХАНШ CAPTION ҮҮ?
    if (caption.startsWith('Өртөг ханш')) {
      if (!currentDate) {
        await ctx.reply('Эхлээд огноо оруулна уу.');
        return;
      }

      const rateMatch = caption.match(/Өртөг ханш[:\s]+([\d\.,]+)/i);
      if (!rateMatch) {
        await ctx.reply('Зөв формат: Өртөг ханш: 46,40');
        return;
      }

      let rateStr = rateMatch[1].replace(/\s+/g, '').replace(',', '.');
      await updateRateForDate(currentDate, rateStr);
      await ctx.reply(`Өртөг ханш ${rateStr} гэж тохирууллаа ✅`);
      return;
    }

    // Бусад caption-тэй зураг → sheet-д бичихгүй
    return;
  } catch (err) {
    console.error(err);
    try {
      await ctx.reply('Дотоод алдаа гарлаа (photo) 😢');
    } catch (e) {}
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

    const parts = data.split(':'); // ["status", "SUCCESS", "12"]
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
    } catch (e) {}

    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.error('Cannot delete message:', e);
    }
  } catch (err) {
    console.error(err);
    try {
      await ctx.answerCbQuery('Алдаа гарлаа 😢', { show_alert: true });
    } catch (e) {}
  }
});

// === Render-д зориулсан ЖИЖИГ HTTP SERVER (PORT BINDING) ===
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
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
