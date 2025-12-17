'use strict';

const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');

// ========== CONFIG ==========
const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || '7716759809:AAHRwI4cgQJd8KXcJcHbQVw2FZFueBja1G0',
  SPREADSHEET_ID: process.env.SPREADSHEET_ID || '1qbxJsI4Ns3a8lluxlRZl5r5AKHA3hp9yS7YZLwY469A',
  RATE_CHANNEL_ID: '-1003355216653',
  ALLOWED_GROUP_ID: '-5069100118',
  ADMIN_IDS: [1447446407, 1920453419],
  PORT: Number(process.env.PORT || 3000),
  WEBHOOK_DOMAIN: process.env.WEBHOOK_DOMAIN || process.env.RENDER_EXTERNAL_URL
};

if (!CONFIG.BOT_TOKEN) throw new Error('BOT_TOKEN байхгүй');
if (!CONFIG.SPREADSHEET_ID) throw new Error('SPREADSHEET_ID байхгүй');

const bot = new Telegraf(CONFIG.BOT_TOKEN);

// ========== GOOGLE SHEETS ==========
const auth = new google.auth.GoogleAuth({
  keyFile: '/etc/secrets/service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });
const SHEET_NAME = 'Transactions2';

// ========== SIMPLE LOCK ==========
let sheetsLock = Promise.resolve();
const lockSheets = (fn) => {
  sheetsLock = sheetsLock.then(fn).catch(fn);
  return sheetsLock;
};

// ========== STATE ==========
const transactionStates = new Map();
let cachedRates = { org: 45.10, person: 45.20, lastUpdate: 0 };

// ========== HELPERS ==========
function isUserAllowed(ctx) {
  const chatId = String(ctx.chat?.id || '');
  const userId = ctx.from?.id;
  return chatId === String(CONFIG.ALLOWED_GROUP_ID) || CONFIG.ADMIN_IDS.includes(userId);
}

function parseNumber(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[,\s]/g, '').trim()) || 0;
}

function formatNumber(num, decimals = 2) {
  return Number(num || 0).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatMNT(num) {
  const n = Math.round(Number(num || 0));
  const abs = Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return (n < 0 ? '-₮' : '₮') + abs;
}

function formatRUB(num) {
  const n = Number(num || 0);
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-₽' : '₽') + abs;
}

// Calculation block: copy-ready mono
function formatCalculation(rub, commission, rubTotal, rate, mntTotal, mntReceived = null) {
  let calc = `<pre>`;
  calc += `+  ${formatNumber(rub).padStart(13)}\n`;
  calc += `+  ${formatNumber(commission).padStart(13)}\n`;
  calc += `${'-'.repeat(15)}\n`;
  calc += `+  ${formatNumber(rubTotal).padStart(13)}\n`;
  calc += `*  ${formatNumber(rate).padStart(13)}\n`;
  calc += `${'-'.repeat(15)}\n`;
  calc += `+  ${formatNumber(mntTotal).padStart(13)}\n`;

  if (mntReceived !== null && Number(mntReceived) > 0) {
    calc += `-  ${formatNumber(mntReceived).padStart(13)}\n`;
    calc += `${'-'.repeat(15)}\n`;
    calc += `+  ${formatNumber(mntTotal - mntReceived).padStart(13)}\n`;
  }

  calc += `</pre>`;
  return calc;
}

function findStateByTxId(chatId, txMessageId) {
  for (const [key, state] of transactionStates.entries()) {
    if (key.startsWith(`${chatId}_`) && String(state.txMessageId) === String(txMessageId)) return state;
  }
  return null;
}

function findActiveState(chatId) {
  for (const [key, state] of transactionStates.entries()) {
    if (key.startsWith(`${chatId}_`)) return state;
  }
  return null;
}

function splitIntoChunks(text, maxLen = 4000) {
  const lines = String(text || '').split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? (current + '\n' + line) : line;
    if (next.length > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Europe/Amsterdam date: safest without timezone libs
const REPORT_TZ = 'Europe/Amsterdam';
function getLocalYMD(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);

  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const d = parts.find(p => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}
function addDaysYMD(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// ========== SHEETS OPS ==========
async function appendTransaction(data) {
  return lockSheets(async () => {
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:S`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          data.number, data.date, data.назначение, data.rub, data.rate,
          data.commission, data.rubTotal, data.mntTotal, data.mntReceived || 0,
          data.mntRemaining, data.status, data.startedAt, data.completedAt || '',
          data.minutes || '', data.chatId, data.txMessageId, data.calcMessageId || '',
          data.rateType || '', data.costRate || ''
        ]]
      }
    });
  });
}

async function findTransactionRow(txMessageId, chatId) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`
  });

  const rows = response.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][15]) === String(txMessageId) && String(rows[i][14]) === String(chatId)) return i + 1;
  }
  return null;
}

async function updateTransaction(rowNum, updates) {
  return lockSheets(async () => {
    const cols = {
      number: 0, date: 1, назначение: 2, rub: 3, rate: 4, commission: 5,
      rubTotal: 6, mntTotal: 7, mntReceived: 8, mntRemaining: 9, status: 10,
      startedAt: 11, completedAt: 12, minutes: 13, chatId: 14, txMessageId: 15,
      calcMessageId: 16, rateType: 17, costRate: 18
    };

    const requests = [];
    for (const [col, value] of Object.entries(updates)) {
      const colIndex = cols[col];
      if (colIndex !== undefined) {
        requests.push({
          range: `${SHEET_NAME}!${String.fromCharCode(65 + colIndex)}${rowNum}`,
          values: [[value]]
        });
      }
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        resource: { valueInputOption: 'USER_ENTERED', data: requests }
      });
    }
  });
}

async function getTransactionsByDateRange(startDate, endDate) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`
  });

  const rows = response.data.values || [];
  const transactions = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const date = row[1] ? String(row[1]).split('T')[0] : '';
    if (!date) continue;

    if (date >= startDate && date <= endDate) {
      const rub = parseNumber(row[3]);
      const rate = parseNumber(row[4]);
      const commission = parseNumber(row[5]);
      const rubTotal = (row[6] !== undefined && row[6] !== '') ? parseNumber(row[6]) : (rub + commission);

      transactions.push({
        number: row[0],
        date: row[1],
        dateYMD: date,
        назначение: row[2] || '',
        rub,
        rate,
        commission,
        rubTotal,
        mntTotal: parseNumber(row[7]),
        mntReceived: parseNumber(row[8]),
        mntRemaining: parseNumber(row[9]),
        status: row[10] || '',
        costRate: parseNumber(row[18])
      });
    }
  }

  return transactions;
}

// ========== RATE HANDLING ==========
async function fetchLatestRates() {
  return cachedRates;
}

bot.on('channel_post', async (ctx) => {
  try {
    if (String(ctx.channelPost?.chat?.id) !== String(CONFIG.RATE_CHANNEL_ID) || !ctx.channelPost.text) return;

    const text = ctx.channelPost.text;
    const orgMatch = text.match(/🏦[^:]*:\s*([\d.,]+)/);
    const personMatch = text.match(/👤[^:]*:\s*([\d.,]+)/);

    if (orgMatch) cachedRates.org = parseFloat(orgMatch[1].replace(',', '.'));
    if (personMatch) cachedRates.person = parseFloat(personMatch[1].replace(',', '.'));

    if (orgMatch || personMatch) {
      cachedRates.lastUpdate = Date.now();
      console.log(`✅ Ханш: 🏦 ${cachedRates.org} | 👤 ${cachedRates.person}`);
    }
  } catch (err) {
    console.error('❌ channel_post:', err);
  }
});

// ========== FLOW HELPERS ==========
async function processCommission(ctx, state) {
  const defaultCommission = state.rub >= 10000000 ? 10000 : 5000;

  if (state.rub >= 10000000) {
    state.step = 'waiting_commission';
    await ctx.reply(
      `💰 <b>Шимтгэл хэд вэ?</b>\n(Санал: ${formatNumber(defaultCommission)} RUB)`,
      { parse_mode: 'HTML', reply_to_message_id: state.txMessageId }
    );
  } else {
    state.commission = defaultCommission;
    await showCalculation(ctx, state);
  }
}

async function showCalculation(ctx, state) {
  state.rubTotal = state.rub + state.commission;
  state.mntTotal = state.rubTotal * state.rate;
  state.mntReceived = 0;
  state.mntRemaining = state.mntTotal;

  const calc = formatCalculation(state.rub, state.commission, state.rubTotal, state.rate, state.mntTotal);

  const msg = await ctx.reply(`📊 <b>Тооцоо:</b>\n\n${calc}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💰 Шимтгэл өөрчлөх', `change_commission_${state.txMessageId}`)],
      [Markup.button.callback('📊 Зарах ханш өөрчлөх', `change_rate_${state.txMessageId}`)],
      [Markup.button.callback('✅ Гүйлгээг батлах', `confirm_transaction_${state.txMessageId}`)]
    ])
  });

  state.calcMessageId = msg.message_id;
  state.step = 'calculation_shown';
}

// ========== CAPTION PARSE (photo / document) ==========
async function handleCaptionTransaction(ctx, caption) {
  if (!isUserAllowed(ctx)) return;
  if (!caption) return;

  const chatId = ctx.chat.id;
  const messageId = ctx.message.message_id;

  const numberMatch = caption.match(/^(\d+)\./m);
  const назначениеMatch = caption.match(/назначени[её][^:]*:\s*(.+)/im);
  const суммаMatch = caption.match(/сумма:\s*([\d,.\s]+)/im);

  if (numberMatch && назначениеMatch && суммаMatch) {
    const number = numberMatch[1];
    const назначение = назначениеMatch[1].trim();
    const rub = parseNumber(суммаMatch[1]);

    const stateKey = `${chatId}_${messageId}`;
    transactionStates.set(stateKey, {
      number,
      назначение,
      rub,
      chatId,
      txMessageId: messageId,
      step: 'waiting_cost_rate',
      startedAt: new Date().toISOString()
    });

    await ctx.reply(
      '💰 <b>Өртөг ханш оруулна уу:</b>\n<i>👆 Энэ зураг/файл мессежид reply хийж бичнэ үү</i>',
      { reply_to_message_id: messageId, parse_mode: 'HTML' }
    );
  }
}

bot.on('photo', async (ctx) => {
  try {
    await handleCaptionTransaction(ctx, ctx.message?.caption || '');
  } catch (err) {
    console.error('❌ photo handler error:', err);
  }
});

bot.on('document', async (ctx) => {
  try {
    await handleCaptionTransaction(ctx, ctx.message?.caption || '');
  } catch (err) {
    console.error('❌ document handler error:', err);
  }
});

// ========== COMMANDS ==========
bot.start(async (ctx) => {
  const msg = `👋 Сайн байна уу!

Би OYUNS Bot. Гүйлгээний тооцоо, бүртгэл болон тайлан гаргахад тусална.

🧾 *Шинэ гүйлгээ оруулах формат (text эсвэл зурагны caption):*
1.
назначение: Тайлбар
сумма: 10000

📌 Дараалал:
1) Дээрх форматаар явуулна
2) Бот “Өртөг ханш” асууна — тухайн мессежид *reply* хийгээд тоогоо бичнэ
3) Дараа нь “Зарах ханш”-аа сонгоно (🏦/👤 эсвэл өөрөө бичиж болно)
4) Бот тооцоо гаргаад баталгаажуулна

📊 Тайлан:
- /report — өнөөдрийн тайлан
- /report 7 — 7 хоногийн тайлан
- /report 2024-01-01 2024-01-31 — огнооны хоорондох тайлан`;

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('ping', async (ctx) => {
  await ctx.reply(`pong ✅\nchatId=${ctx.chat.id}\nuserId=${ctx.from.id}\ntype=${ctx.chat.type}`);
});

bot.command('debug', async (ctx) => {
  const info = `🔍 <b>DEBUG</b>

💬 Chat ID: <code>${ctx.chat.id}</code>
👤 User ID: <code>${ctx.from.id}</code>

💰 Ханш:
- 🏦 Байгууллага: ${cachedRates.org}
- 👤 Хувь хүн: ${cachedRates.person}

${isUserAllowed(ctx) ? '✅' : '❌'} Allowed`;
  await ctx.reply(info, { parse_mode: 'HTML' });
});

// ========== REPORT COMMAND ==========
bot.command('report', async (ctx) => {
  if (!isUserAllowed(ctx)) return;

  try {
    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const todayStr = getLocalYMD(new Date());

    let startDate = todayStr;
    let endDate = todayStr;

    if (args.length === 0) {
      // today
    } else if (args.length === 1 || (args.length === 2 && args[1] === 'хоног')) {
      const days = Math.max(1, parseInt(args[0], 10) || 1);
      startDate = addDaysYMD(todayStr, -(days - 1));
      endDate = todayStr;
    } else if (args.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(args[0]) && /^\d{4}-\d{2}-\d{2}$/.test(args[1])) {
      startDate = args[0];
      endDate = args[1];
      if (startDate > endDate) [startDate, endDate] = [endDate, startDate];
    } else {
      await ctx.reply('❌ Буруу формат. Жишээ:\n/report\n/report 7\n/report 2024-01-01 2024-01-31');
      return;
    }

    const transactions = await getTransactionsByDateRange(startDate, endDate);

    if (transactions.length === 0) {
      await ctx.reply('📊 Тайлан\nСонгосон хугацаанд гүйлгээ байхгүй байна.');
      return;
    }

    const completed = transactions.filter(t => String(t.status).trim() === 'Амжилттай');
    const pending = transactions.filter(t => String(t.status).trim() !== 'Амжилттай');

    const totalMNT = transactions.reduce((s, t) => s + (t.mntTotal || 0), 0);
    const totalRUB = transactions.reduce((s, t) => s + (t.rubTotal || 0), 0);

    const totalProfit = transactions.reduce((s, t) => s + ((t.rate - t.costRate) * (t.rub || 0)), 0);
    const lossTransactions = transactions.filter(t => ((t.rate - t.costRate) * (t.rub || 0)) < 0);
    const lossSum = lossTransactions.reduce((s, t) => s + ((t.rate - t.costRate) * (t.rub || 0)), 0); // negative

    let report = '';
    report += `📈 <b>Товч мэдээлэл:</b>\n\n`;
    report += `Нийт гүйлгээний дүн: ${formatMNT(totalMNT)} / ${formatRUB(totalRUB)}\n\n`;
    report += `Нийт ашиг: ${formatMNT(totalProfit)}\n\n`;
    report += `Нийт гүйлгээний тоо: ${transactions.length}\n\n`;

    report += `📊 <b>Гүйлгээний төлөв:</b>\n\n`;
    report += `Амжилттай: ${completed.length}\n\n`;
    report += `Хүлээгдэж байгаа: ${pending.length}\n\n`;

    report += `🔽<b>Алдагдалтай гүйлгээний тоо:</b> ${lossTransactions.length}\n\n`;
    report += `Алдагдлын хэмжээ: ${formatMNT(lossSum)}\n\n`;

    if (pending.length > 0) {
      report += `<b>Хүлээгдэж буй гүйлгээ:</b>\n\n`;

      let idx = 1;
      for (const t of pending) {
        report += `${idx}) <b>Назначение:</b> ${t.назначение}\n\n`;
        const calc = formatCalculation(t.rub, t.commission, t.rubTotal, t.rate, t.mntTotal, t.mntReceived);
        report += `<b>Тооцоо:</b>\n\n${calc}\n\n`;
        report += `<b>Үлдэгдэл:</b> ${formatNumber(t.mntRemaining, 2)}\n\n`;
        idx++;
      }
    } else {
      report += `<b>Хүлээгдэж буй гүйлгээ:</b> Байхгүй\n`;
    }

    const header = `📊 <b>Тайлан</b> (${startDate} — ${endDate})\n<i>${REPORT_TZ}</i>\n\n`;
    const full = header + report;

    const chunks = splitIntoChunks(full, 3900);
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('❌ Report error:', err);
    await ctx.reply('❌ Тайлан гаргахад алдаа гарлаа.');
  }
});

// ========== TEXT HANDLER ==========
bot.on('text', async (ctx, next) => {
  try {
    const text = ctx.message?.text || '';

    // let bot.command handlers run
    if (text.startsWith('/')) return next();

    if (!isUserAllowed(ctx)) return;

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    // 1) NEW TX detect
    const numberMatch = text.match(/^(\d+)\./m);
    const назначениеMatch = text.match(/назначени[её][^:]*:\s*(.+)/im);
    const суммаMatch = text.match(/сумма:\s*([\d,.\s]+)/im);

    if (numberMatch && назначениеMatch && суммаMatch) {
      const stateKey = `${chatId}_${messageId}`;
      transactionStates.set(stateKey, {
        number: numberMatch[1],
        назначение: назначениеMatch[1].trim(),
        rub: parseNumber(суммаMatch[1]),
        chatId,
        txMessageId: messageId,
        step: 'waiting_cost_rate',
        startedAt: new Date().toISOString()
      });

      await ctx.reply('💰 <b>Өртөг ханш оруулна уу:</b>\n<i>👆 Энэ мессежид reply хийж бичнэ үү</i>', {
        reply_to_message_id: messageId,
        parse_mode: 'HTML'
      });
      return;
    }

    // 2) Find state (prefer reply -> correct tx)
    let activeState = null;
    if (ctx.message.reply_to_message) {
      activeState = findStateByTxId(chatId, ctx.message.reply_to_message.message_id);
    }
    if (!activeState) activeState = findActiveState(chatId);
    if (!activeState) return;

    // waiting_cost_rate (require reply to original tx message)
    if (activeState.step === 'waiting_cost_rate') {
      if (!ctx.message.reply_to_message || String(ctx.message.reply_to_message.message_id) !== String(activeState.txMessageId)) {
        await ctx.reply('⚠️ <b>Гүйлгээний мессежид reply хийж өртөг ханш оруулна уу!</b>', {
          parse_mode: 'HTML',
          reply_to_message_id: activeState.txMessageId
        });
        return;
      }

      const costRate = parseNumber(text);
      if (costRate <= 0) {
        await ctx.reply('❌ <b>Зөв тоо оруулна уу!</b>', { parse_mode: 'HTML', reply_to_message_id: activeState.txMessageId });
        return;
      }

      activeState.costRate = costRate;
      activeState.step = 'waiting_sell_rate';

      const rates = await fetchLatestRates();
      await ctx.reply('📊 <b>Зарах ханш сонгоно уу:</b>', {
        reply_to_message_id: activeState.txMessageId,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`🏦 ${rates.org.toFixed(2)}`, `rate_org_${activeState.txMessageId}`),
            Markup.button.callback(`👤 ${rates.person.toFixed(2)}`, `rate_person_${activeState.txMessageId}`)
          ],
          [Markup.button.callback('✍️ Өөр ханш оруулах', `rate_custom_${activeState.txMessageId}`)]
        ])
      });
      return;
    }

    // waiting_custom_rate
    if (activeState.step === 'waiting_custom_rate') {
      const customRate = parseNumber(text);
      if (customRate <= 0) {
        await ctx.reply('❌ <b>Зөв ханш оруулна уу!</b>', { parse_mode: 'HTML', reply_to_message_id: activeState.txMessageId });
        return;
      }
      activeState.rate = customRate;
      activeState.rateType = 'Өөр';
      await processCommission(ctx, activeState);
      return;
    }

    // waiting_commission
    if (activeState.step === 'waiting_commission') {
      const commission = parseNumber(text);
      if (commission <= 0) {
        await ctx.reply('❌ <b>Зөв дүн оруулна уу!</b>', { parse_mode: 'HTML', reply_to_message_id: activeState.txMessageId });
        return;
      }
      activeState.commission = commission;
      await showCalculation(ctx, activeState);
      return;
    }

    // waiting_partial_mnt
    if (activeState.step === 'waiting_partial_mnt') {
      const mnt = parseNumber(text);
      if (mnt <= 0) {
        await ctx.reply('❌ <b>Зөв дүн оруулна уу!</b>', { parse_mode: 'HTML', reply_to_message_id: activeState.txMessageId });
        return;
      }

      activeState.mntReceived = (activeState.mntReceived || 0) + mnt;
      activeState.mntRemaining = activeState.mntTotal - activeState.mntReceived;

      const rowNum = await findTransactionRow(activeState.txMessageId, chatId);
      if (rowNum) {
        await updateTransaction(rowNum, {
          mntReceived: activeState.mntReceived,
          mntRemaining: activeState.mntRemaining,
          status: activeState.mntRemaining <= 0 ? 'Амжилттай' : 'Хэсэгчлэн орсон'
        });
      }

      const calc = formatCalculation(
        activeState.rub, activeState.commission, activeState.rubTotal,
        activeState.rate, activeState.mntTotal, activeState.mntReceived
      );

      await ctx.reply(`✅ <b>Хэсэгчлэн орлоо:</b> ${formatNumber(mnt)} MNT\n\n${calc}`, {
        parse_mode: 'HTML',
        reply_to_message_id: activeState.txMessageId
      });

      if (activeState.mntRemaining <= 0) {
        const completedAt = new Date().toISOString();
        const minutes = Math.round((new Date(completedAt) - new Date(activeState.startedAt)) / 60000);

        if (rowNum) await updateTransaction(rowNum, { completedAt, minutes, status: 'Амжилттай' });

        await ctx.reply('🎉 <b>Гүйлгээ амжилттай хаагдлаа!</b>', {
          parse_mode: 'HTML',
          reply_to_message_id: activeState.txMessageId
        });

        transactionStates.delete(`${chatId}_${activeState.txMessageId}`);
      } else {
        activeState.step = 'waiting_confirmation';
        await ctx.reply('💵 <b>MNT бүтэн орсон уу?</b>', {
          parse_mode: 'HTML',
          reply_to_message_id: activeState.txMessageId,
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Бүтэн орсон', `confirm_full_${activeState.txMessageId}`)],
            [Markup.button.callback('🟠 Дахин хэсэгчлэн орсон', `confirm_partial_${activeState.txMessageId}`)]
          ])
        });
      }
      return;
    }
  } catch (err) {
    console.error('❌ Text handler:', err);
    return next?.();
  }
});

// ========== CALLBACKS ==========
bot.action(/rate_(org|person|custom)_(.+)/, async (ctx) => {
  try {
    if (!isUserAllowed(ctx)) return;

    const [, type, txMessageId] = ctx.match;
    const state = findStateByTxId(ctx.chat.id, txMessageId);
    if (!state) return;

    const rates = await fetchLatestRates();

    if (type === 'org') {
      state.rate = rates.org;
      state.rateType = 'Байгууллага';
      await ctx.answerCbQuery('🏦 Сонгогдлоо');
      await processCommission(ctx, state);
      return;
    }

    if (type === 'person') {
      state.rate = rates.person;
      state.rateType = 'Хувь хүн';
      await ctx.answerCbQuery('👤 Сонгогдлоо');
      await processCommission(ctx, state);
      return;
    }

    state.step = 'waiting_custom_rate';
    await ctx.answerCbQuery();
    await ctx.reply('✍️ <b>Зарах ханш оруулна уу:</b>', {
      parse_mode: 'HTML',
      reply_to_message_id: state.txMessageId
    });
  } catch (err) {
    console.error('❌ rate callback error:', err);
  }
});

bot.action(/change_commission_(.+)/, async (ctx) => {
  try {
    if (!isUserAllowed(ctx)) return;

    const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
    if (!state) return;

    state.step = 'waiting_commission';
    await ctx.answerCbQuery();
    await ctx.reply('💰 <b>Шимтгэл оруулна уу:</b>', {
      parse_mode: 'HTML',
      reply_to_message_id: state.calcMessageId || state.txMessageId
    });
  } catch (err) {
    console.error('❌ change_commission error:', err);
  }
});

bot.action(/change_rate_(.+)/, async (ctx) => {
  try {
    if (!isUserAllowed(ctx)) return;

    const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
    if (!state) return;

    const rates = await fetchLatestRates();
    await ctx.answerCbQuery();

    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [
          { text: `🏦 ${rates.org.toFixed(2)}`, callback_data: `rate_org_${ctx.match[1]}` },
          { text: `👤 ${rates.person.toFixed(2)}`, callback_data: `rate_person_${ctx.match[1]}` }
        ],
        [{ text: '✍️ Өөр ханш оруулах', callback_data: `rate_custom_${ctx.match[1]}` }]
      ]
    });
  } catch (err) {
    console.error('❌ change_rate error:', err);
  }
});

bot.action(/confirm_transaction_(.+)/, async (ctx) => {
  try {
    if (!isUserAllowed(ctx)) return;

    const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
    if (!state) return;

    await ctx.answerCbQuery();

    const rowNum = await findTransactionRow(state.txMessageId, ctx.chat.id);
    if (!rowNum) {
      await appendTransaction({
        number: state.number,
        date: new Date().toISOString(),
        назначение: state.назначение,
        rub: state.rub,
        rate: state.rate,
        commission: state.commission,
        rubTotal: state.rubTotal,
        mntTotal: state.mntTotal,
        mntReceived: 0,
        mntRemaining: state.mntTotal,
        status: 'Хүлээгдэж буй',
        startedAt: state.startedAt,
        chatId: state.chatId,
        txMessageId: state.txMessageId,
        calcMessageId: state.calcMessageId,
        rateType: state.rateType,
        costRate: state.costRate
      });
    }

    state.step = 'waiting_confirmation';
    await ctx.reply('💵 <b>MNT бүтэн орсон уу?</b>', {
      parse_mode: 'HTML',
      reply_to_message_id: state.txMessageId,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Бүтэн орсон', `confirm_full_${ctx.match[1]}`)],
        [Markup.button.callback('🟠 Хэсэгчлэн орсон', `confirm_partial_${ctx.match[1]}`)]
      ])
    });
  } catch (err) {
    console.error('❌ confirm_transaction error:', err);
  }
});

bot.action(/confirm_full_(.+)/, async (ctx) => {
  try {
    if (!isUserAllowed(ctx)) return;

    const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
    if (!state) return;

    await ctx.answerCbQuery('✅ Амжилттай');

    state.mntReceived = state.mntTotal;
    state.mntRemaining = 0;

    const completedAt = new Date().toISOString();
    const minutes = Math.round((new Date(completedAt) - new Date(state.startedAt)) / 60000);

    const rowNum = await findTransactionRow(ctx.match[1], ctx.chat.id);
    if (rowNum) {
      await updateTransaction(rowNum, {
        mntReceived: state.mntTotal,
        mntRemaining: 0,
        status: 'Амжилттай',
        completedAt,
        minutes
      });
    }

    await ctx.editMessageText('🎉 <b>Гүйлгээ амжилттай хаагдлаа!</b>', { parse_mode: 'HTML' });
    transactionStates.delete(`${ctx.chat.id}_${ctx.match[1]}`);
  } catch (err) {
    console.error('❌ confirm_full error:', err);
  }
});

bot.action(/confirm_partial_(.+)/, async (ctx) => {
  try {
    if (!isUserAllowed(ctx)) return;

    const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
    if (!state) return;

    await ctx.answerCbQuery();
    state.step = 'waiting_partial_mnt';

    await ctx.reply('💸 <b>Ороод ирсэн MNT дүнг оруулна уу:</b>', {
      parse_mode: 'HTML',
      reply_to_message_id: state.calcMessageId || state.txMessageId
    });
  } catch (err) {
    console.error('❌ confirm_partial error:', err);
  }
});

// ========== WEBHOOK SERVER (Render) / POLLING FALLBACK ==========
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.status(200).send('OYUNS Bot is running!'));
app.get('/health', (req, res) => res.status(200).send('OK'));

const webhookPath = `/telegraf/${CONFIG.BOT_TOKEN}`;
app.post(webhookPath, (req, res) => bot.handleUpdate(req.body, res));

async function start() {
  app.listen(CONFIG.PORT, () => {
    console.log(`✅ Server listening on port ${CONFIG.PORT}`);
  });

  if (CONFIG.WEBHOOK_DOMAIN) {
    const webhookUrl = `${CONFIG.WEBHOOK_DOMAIN}${webhookPath}`;
    await bot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'callback_query', 'channel_post']
    });
    console.log(`✅ Webhook set: ${webhookUrl}`);
  } else {
    console.log('ℹ️ WEBHOOK_DOMAIN байхгүй тул polling mode асаалаа.');
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    bot.launch();
    console.log('✅ Bot launched (polling)');
  }
}

start().catch((err) => {
  console.error('❌ Start error:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
