'use strict';

const fs = require('fs');
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');

/* ================= CONFIG ================= */
const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',

  SPREADSHEET_ID: process.env.SPREADSHEET_ID || '1qbxJsI4Ns3a8lluxlRZl5r5AKHA3hp9yS7YZLwY469A',
  RATE_CHANNEL_ID: process.env.RATE_CHANNEL_ID || '-1003355216653',
  ALLOWED_GROUP_ID: process.env.ALLOWED_GROUP_ID ? Number(process.env.ALLOWED_GROUP_ID) : -5069100118,
  ADMIN_IDS: process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map((x) => Number(x.trim())).filter(Boolean)
    : [1447446407, 1920453419],

  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,

  GOOGLE_APPLICATION_CREDENTIALS:
    process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/service-account.json',
};

if (!CONFIG.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN байхгүй. Render -> Environment Variables дээр BOT_TOKEN тавина уу.');
  process.exit(1);
}

/* ================= GOOGLE AUTH ================= */
function loadGoogleCredentials() {
  const keyFile = CONFIG.GOOGLE_APPLICATION_CREDENTIALS;

  if (!fs.existsSync(keyFile)) {
    console.error(`❌ Service account файл олдсонгүй: ${keyFile}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(keyFile, 'utf8');
  const creds = JSON.parse(raw);

  // private_key дээр \n escape байвал засна
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  return creds;
}

const auth = new google.auth.GoogleAuth({
  credentials: loadGoogleCredentials(),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SHEET_NAME = 'Transactions2';

/* ================= SHEETS LOCK ================= */
let sheetsLock = Promise.resolve();
const lockSheets = (fn) => {
  sheetsLock = sheetsLock.then(fn).catch(fn);
  return sheetsLock;
};

/* ================= BOT ================= */
const bot = new Telegraf(CONFIG.BOT_TOKEN);

/* ================= STATE ================= */
const transactionStates = new Map(); // key: `${chatId}_${txMessageId}`
let cachedRates = { org: 45.10, person: 45.20, lastUpdate: 0 };

/* ================= HELPERS ================= */
function parseNumber(str) {
  if (!str) return 0;
  const s = str.toString().replace(/,/g, '').trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function formatNumber(num) {
  return Number(num || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(str) {
  return (str ?? '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* === CALCULATION (partials цувж харуулна) === */
function formatCalculation(rub, commission, rubTotal, rate, mntTotal, partials = []) {
  let out = `<pre>`;
  out += `+  ${formatNumber(rub).padStart(13)}\n`;
  out += `+  ${formatNumber(commission).padStart(13)}\n`;
  out += `${'-'.repeat(15)}\n`;
  out += `+  ${formatNumber(rubTotal).padStart(13)}\n`;
  out += `*  ${formatNumber(rate).padStart(13)}\n`;
  out += `${'-'.repeat(15)}\n`;
  out += `+  ${formatNumber(mntTotal).padStart(13)}\n`;

  let sum = 0;
  for (const p of partials) {
    sum += p;
    out += `-  ${formatNumber(p).padStart(13)}\n`;
  }

  if (partials.length) {
    out += `${'-'.repeat(15)}\n`;
    out += `+  ${formatNumber(mntTotal - sum).padStart(13)}\n`;
  }

  out += `</pre>`;
  return out;
}

/* ================= SHEETS OPS ================= */
async function appendTransaction(data) {
  return lockSheets(async () => {
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:S`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          data.number,
          data.date,
          data.назначение,
          data.rub,
          data.rate,
          data.commission,
          data.rubTotal,
          data.mntTotal,
          data.mntReceived || 0,
          data.mntRemaining,
          data.status,
          data.startedAt,
          data.completedAt || '',
          data.minutes || '',
          data.chatId,
          data.txMessageId,
          data.calcMessageId || '',
          data.rateType || '',
          data.costRate || ''
        ]]
      },
    });
  });
}

async function findTransactionRow(txMessageId, chatId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`,
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][15] == txMessageId && rows[i][14] == chatId) return i + 1; // 1-based row
  }
  return null;
}

async function updateTransaction(row, updates) {
  return lockSheets(async () => {
    const cols = {
      number: 0, date: 1, назначение: 2, rub: 3, rate: 4,
      commission: 5, rubTotal: 6, mntTotal: 7, mntReceived: 8,
      mntRemaining: 9, status: 10, startedAt: 11, completedAt: 12,
      minutes: 13, chatId: 14, txMessageId: 15, calcMessageId: 16,
      rateType: 17, costRate: 18,
    };

    const data = [];
    for (const [k, v] of Object.entries(updates)) {
      if (!(k in cols)) continue;
      data.push({
        range: `${SHEET_NAME}!${String.fromCharCode(65 + cols[k])}${row}`,
        values: [[v]],
      });
    }

    if (!data.length) return;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      resource: { valueInputOption: 'USER_ENTERED', data },
    });
  });
}

async function getTodayTransactions() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`,
  });

  const rows = res.data.values || [];
  const today = new Date().toISOString().split('T')[0];

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const date = r[1] ? r[1].split('T')[0] : '';
    if (date !== today) continue;

    out.push({
      number: r[0],
      date: r[1],
      назначение: r[2] || '',
      rub: parseNumber(r[3]),
      rate: parseNumber(r[4]),
      commission: parseNumber(r[5]),
      rubTotal: parseNumber(r[6]),
      mntTotal: parseNumber(r[7]),
      mntReceived: parseNumber(r[8]),
      mntRemaining: parseNumber(r[9]),
      status: r[10] || '',
      startedAt: r[11] || '',
      costRate: parseNumber(r[18]),
      chatId: r[14],
      txMessageId: r[15],
    });
  }

  return out;
}

/* ================= RATES ================= */
async function fetchLatestRates() {
  return cachedRates;
}

bot.on('channel_post', async (ctx) => {
  try {
    if (ctx.channelPost.chat.id != CONFIG.RATE_CHANNEL_ID) return;
    if (!ctx.channelPost.text) return;

    const text = ctx.channelPost.text;

    const orgMatch = text.match(/🏦[^:]*:\s*([\d.,]+)/);
    const personMatch = text.match(/👤[^:]*:\s*([\d.,]+)/);

    if (orgMatch) cachedRates.org = parseFloat(orgMatch[1].replace(',', '.'));
    if (personMatch) cachedRates.person = parseFloat(personMatch[1].replace(',', '.'));

    if (orgMatch || personMatch) cachedRates.lastUpdate = Date.now();
  } catch (e) {
    console.error('❌ channel_post error:', e);
  }
});

/* ================= FLOW HELPERS ================= */
function isAllowed(ctx) {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  return chatId === CONFIG.ALLOWED_GROUP_ID || CONFIG.ADMIN_IDS.includes(userId);
}

function findStateByTxId(chatId, txMessageId) {
  for (const [k, s] of transactionStates.entries()) {
    if (k.startsWith(`${chatId}_`) && String(s.txMessageId) === String(txMessageId)) return s;
  }
  return null;
}

async function showSellRateChoice(ctx, state) {
  const rates = await fetchLatestRates();
  await ctx.reply('📊 <b>Зарах ханш сонгоно уу:</b>', {
    parse_mode: 'HTML',
    reply_to_message_id: state.txMessageId,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(`🏦 ${rates.org.toFixed(2)}`, `rate_org_${state.txMessageId}`),
        Markup.button.callback(`👤 ${rates.person.toFixed(2)}`, `rate_person_${state.txMessageId}`),
      ],
      [Markup.button.callback('✍️ Өөр ханш оруулах', `rate_custom_${state.txMessageId}`)],
    ]),
  });
}

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

  // partial history (цувж)
  state.partialMntHistory = state.partialMntHistory || [];
  const sum = state.partialMntHistory.reduce((a, b) => a + b, 0);

  state.mntReceived = sum;
  state.mntRemaining = state.mntTotal - sum;

  const calc = formatCalculation(
    state.rub,
    state.commission,
    state.rubTotal,
    state.rate,
    state.mntTotal,
    state.partialMntHistory
  );

  const msg = await ctx.reply(`📊 <b>Тооцоо:</b>\n\n${calc}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💰 Шимтгэл өөрчлөх', `change_commission_${state.txMessageId}`)],
      [Markup.button.callback('📊 Зарах ханш өөрчлөх', `change_rate_${state.txMessageId}`)],
      [Markup.button.callback('✅ Гүйлгээг батлах', `confirm_transaction_${state.txMessageId}`)],
    ]),
  });

  state.calcMessageId = msg.message_id;
  state.step = 'calculation_shown';
}

/* ================= INCOMING (photo/text) ================= */
bot.on('photo', async (ctx) => {
  try {
    if (!isAllowed(ctx)) return;

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const caption = (ctx.message.caption || '').trim();

    const numberMatch = caption.match(/^(\d+)\./m);
    const назначениеMatch = caption.match(/Назначение:\s*(.+)/i);
    const суммаMatch = caption.match(/Сумма:\s*([\d,]+\.?\d*)/i);

    if (!numberMatch || !назначениеMatch || !суммаMatch) return;

    const stateKey = `${chatId}_${messageId}`;
    transactionStates.set(stateKey, {
      number: numberMatch[1],
      назначение: назначениеMatch[1].trim(),
      rub: parseNumber(суммаMatch[1]),
      chatId,
      txMessageId: messageId,
      step: 'waiting_cost_rate',
      startedAt: new Date().toISOString(),
      partialMntHistory: [],
    });

    await ctx.reply('💰 <b>Өртөг ханш оруулна уу:</b>', { parse_mode: 'HTML' });
  } catch (e) {
    console.error('❌ photo handler:', e);
  }
});

bot.on('text', async (ctx, next) => {
  try {
    const text = (ctx.message.text || '').trim();
    if (text.startsWith('/')) return next();
    if (!isAllowed(ctx)) return;

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    // 1) Шинэ гүйлгээ таних
    const numberMatch = text.match(/^(\d+)\./m);
    const назначениеMatch = text.match(/Назначение:\s*(.+)/i);
    const суммаMatch = text.match(/Сумма:\s*([\d,]+\.?\d*)/i);

    if (numberMatch && назначениеMatch && суммаMatch) {
      const stateKey = `${chatId}_${messageId}`;
      transactionStates.set(stateKey, {
        number: numberMatch[1],
        назначение: назначениеMatch[1].trim(),
        rub: parseNumber(суммаMatch[1]),
        chatId,
        txMessageId: messageId,
        step: 'waiting_cost_rate',
        startedAt: new Date().toISOString(),
        partialMntHistory: [],
      });

      await ctx.reply('💰 <b>Өртөг ханш оруулна уу:</b>', { parse_mode: 'HTML' });
      return;
    }

    // 2) State барих (хамгийн сүүлийн идэвхтэй гүйлгээг барина)
    let activeState = null;
    for (const [k, s] of transactionStates.entries()) {
      if (k.startsWith(`${chatId}_`)) {
        activeState = s;
        break;
      }
    }
    if (!activeState) return;

    // Өртөг ханш
    if (activeState.step === 'waiting_cost_rate') {
      const costRate = parseNumber(text);
      if (costRate > 0) {
        activeState.costRate = costRate;
        activeState.step = 'waiting_sell_rate';
        await showSellRateChoice(ctx, activeState);
      }
      return;
    }

    // Custom ханш
    if (activeState.step === 'waiting_custom_rate') {
      const customRate = parseNumber(text);
      if (customRate > 0) {
        activeState.rate = customRate;
        activeState.rateType = 'Өөр';
        await processCommission(ctx, activeState);
      }
      return;
    }

    // Шимтгэл
    if (activeState.step === 'waiting_commission') {
      const commission = parseNumber(text);
      if (commission > 0) {
        activeState.commission = commission;
        await showCalculation(ctx, activeState);
      }
      return;
    }

    // Хэсэгчлэн MNT
    if (activeState.step === 'waiting_partial_mnt') {
      const mnt = parseNumber(text);
      if (mnt > 0) {
        activeState.partialMntHistory = activeState.partialMntHistory || [];
        activeState.partialMntHistory.push(mnt);

        const sum = activeState.partialMntHistory.reduce((a, b) => a + b, 0);
        activeState.mntReceived = sum;
        activeState.mntRemaining = activeState.mntTotal - sum;

        const rowNum = await findTransactionRow(activeState.txMessageId, chatId);
        if (rowNum) {
          await updateTransaction(rowNum, {
            mntReceived: activeState.mntReceived,
            mntRemaining: activeState.mntRemaining,
            status: activeState.mntRemaining <= 0 ? 'Амжилттай' : 'Хэсэгчлэн орсон',
          });
        }

        const calc = formatCalculation(
          activeState.rub,
          activeState.commission,
          activeState.rubTotal,
          activeState.rate,
          activeState.mntTotal,
          activeState.partialMntHistory
        );

        await ctx.reply(
          `✅ <b>Хэсэгчлэн хүлээн авлаа:</b> ${formatNumber(mnt)} MNT\n\n${calc}`,
          { parse_mode: 'HTML' }
        );

        if (activeState.mntRemaining <= 0) {
          const completedAt = new Date().toISOString();
          const minutes = Math.round((new Date(completedAt) - new Date(activeState.startedAt)) / 60000);

          if (rowNum) {
            await updateTransaction(rowNum, {
              completedAt,
              minutes,
              status: 'Амжилттай',
            });
          }

          await ctx.reply('🎉 <b>Гүйлгээ амжилттай хаагдлаа!</b>', { parse_mode: 'HTML' });
          // state устгана
          transactionStates.delete(`${chatId}_${activeState.txMessageId}`);
        } else {
          activeState.step = 'waiting_confirmation';
          await ctx.reply(
            '💵 <b>MNT бүтэн хүлээн авсан уу?</b>',
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Бүтэн хүлээн авсан', `confirm_full_${activeState.txMessageId}`)],
                [Markup.button.callback('🟠 Дахин хэсэгчлэн хүлээн авсан', `confirm_partial_${activeState.txMessageId}`)],
              ]),
            }
          );
        }
      }
      return;
    }
  } catch (e) {
    console.error('❌ text handler:', e);
  }
});

/* ================= CALLBACKS ================= */
bot.action(/rate_(org|person|custom)_(.+)/, async (ctx) => {
  try {
    const [, type, txMessageId] = ctx.match;
    const chatId = ctx.chat.id;

    const state = findStateByTxId(chatId, txMessageId);
    if (!state) return;

    const rates = await fetchLatestRates();

    if (type === 'org') {
      state.rate = rates.org;
      state.rateType = 'Байгууллага';
      state.step = 'waiting_commission';
      await ctx.answerCbQuery('🏦 Сонгогдлоо');
      await processCommission(ctx, state);
      return;
    }

    if (type === 'person') {
      state.rate = rates.person;
      state.rateType = 'Хувь хүн';
      state.step = 'waiting_commission';
      await ctx.answerCbQuery('👤 Сонгогдлоо');
      await processCommission(ctx, state);
      return;
    }

    // custom
    state.step = 'waiting_custom_rate';
    await ctx.answerCbQuery();
    await ctx.reply('✍️ <b>Зарах ханш оруулна уу:</b>', {
      parse_mode: 'HTML',
      reply_to_message_id: state.txMessageId,
    });
  } catch (e) {
    console.error('❌ rate action:', e);
  }
});

bot.action(/change_commission_(.+)/, async (ctx) => {
  try {
    const txMessageId = ctx.match[1];
    const chatId = ctx.chat.id;

    const state = findStateByTxId(chatId, txMessageId);
    if (!state) return;

    state.step = 'waiting_commission';
    await ctx.answerCbQuery();
    await ctx.reply('💰 <b>Шимтгэл оруулна уу:</b>', {
      parse_mode: 'HTML',
      reply_to_message_id: state.calcMessageId || state.txMessageId,
    });
  } catch (e) {
    console.error('❌ change_commission:', e);
  }
});

bot.action(/change_rate_(.+)/, async (ctx) => {
  try {
    const txMessageId = ctx.match[1];
    const chatId = ctx.chat.id;

    const state = findStateByTxId(chatId, txMessageId);
    if (!state) return;

    const rates = await fetchLatestRates();
    await ctx.answerCbQuery();

    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [
          { text: `🏦 ${rates.org.toFixed(2)}`, callback_data: `rate_org_${txMessageId}` },
          { text: `👤 ${rates.person.toFixed(2)}`, callback_data: `rate_person_${txMessageId}` },
        ],
        [{ text: '✍️ Өөр ханш оруулах', callback_data: `rate_custom_${txMessageId}` }],
      ],
    });
  } catch (e) {
    console.error('❌ change_rate:', e);
  }
});

bot.action(/confirm_transaction_(.+)/, async (ctx) => {
  try {
    const txMessageId = ctx.match[1];
    const chatId = ctx.chat.id;

    const state = findStateByTxId(chatId, txMessageId);
    if (!state) return;

    await ctx.answerCbQuery();

    // Sheets дээр байхгүй бол append
    const rowNum = await findTransactionRow(state.txMessageId, chatId);
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
        mntReceived: state.mntReceived || 0,
        mntRemaining: state.mntRemaining,
        status: 'Хүлээгдэж буй',
        startedAt: state.startedAt,
        chatId: state.chatId,
        txMessageId: state.txMessageId,
        calcMessageId: state.calcMessageId,
        rateType: state.rateType,
        costRate: state.costRate,
      });
    }

    state.step = 'waiting_confirmation';

    await ctx.reply('💵 <b>MNT бүтэн хүлээн авсан уу?</b>', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Бүтэн хүлээн авсан', `confirm_full_${txMessageId}`)],
        [Markup.button.callback('🟠 Хэсэгчлэн хүлээн авсан', `confirm_partial_${txMessageId}`)],
      ]),
    });
  } catch (e) {
    console.error('❌ confirm_transaction:', e);
  }
});

bot.action(/confirm_full_(.+)/, async (ctx) => {
  try {
    const txMessageId = ctx.match[1];
    const chatId = ctx.chat.id;

    const state = findStateByTxId(chatId, txMessageId);
    if (!state) return;

    await ctx.answerCbQuery('✅ Амжилттай');

    // full гэж үзээд total-аа авна
    state.partialMntHistory = state.partialMntHistory || [];
    const sum = state.partialMntHistory.reduce((a, b) => a + b, 0);
    state.mntReceived = state.mntTotal; // бүрэн орсон
    state.mntRemaining = 0;

    const completedAt = new Date().toISOString();
    const minutes = Math.round((new Date(completedAt) - new Date(state.startedAt)) / 60000);

    const rowNum = await findTransactionRow(txMessageId, chatId);
    if (rowNum) {
      await updateTransaction(rowNum, {
        mntReceived: state.mntTotal,
        mntRemaining: 0,
        status: 'Амжилттай',
        completedAt,
        minutes,
      });
    }

    await ctx.editMessageText('🎉 <b>Гүйлгээ амжилттай хаагдлаа!</b>', { parse_mode: 'HTML' });
    transactionStates.delete(`${chatId}_${txMessageId}`);
  } catch (e) {
    console.error('❌ confirm_full:', e);
  }
});

bot.action(/confirm_partial_(.+)/, async (ctx) => {
  try {
    const txMessageId = ctx.match[1];
    const chatId = ctx.chat.id;

    const state = findStateByTxId(chatId, txMessageId);
    if (!state) return;

    await ctx.answerCbQuery();
    state.step = 'waiting_partial_mnt';

    await ctx.reply('💸 <b>Хүлээн авсан MNT дүнг оруулна уу:</b>', {
      parse_mode: 'HTML',
      reply_to_message_id: state.calcMessageId || state.txMessageId,
    });
  } catch (e) {
    console.error('❌ confirm_partial:', e);
  }
});

/* ================= COMMANDS ================= */
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const isAdmin = CONFIG.ADMIN_IDS.includes(userId);
  const isGroup = chatId === CONFIG.ALLOWED_GROUP_ID;

  let msg = '👋 <b>Сайн байна уу!</b>\n\n';
  if (isAdmin || isGroup) {
    msg += '✅ Та энэ ботыг ашиглах эрхтэй байна.\n\n';
    msg += '<b>📋 Командууд:</b>\n';
    msg += '/report - Өнөөдрийн тайлан\n';
    msg += '/debug - Debug\n';
  } else {
    msg += '⚠️ Та энэ ботыг ашиглах эрхгүй байна.';
  }

  await ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.command('report', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  if (chatId !== CONFIG.ALLOWED_GROUP_ID && !CONFIG.ADMIN_IDS.includes(userId)) {
    await ctx.reply('⚠️ Энэ команд зөвхөн зөвшөөрөгдсөн группт эсвэл админд ажиллана.');
    return;
  }

  try {
    const transactions = await getTodayTransactions();
    const completed = transactions.filter(t => t.status === 'Амжилттай');
    const pending = transactions.filter(t => t.status !== 'Амжилттай');

    let report = '📊 <b>ӨНӨӨДРИЙН ТАЙЛАН</b>\n\n';

    if (completed.length) {
      const totalRub = completed.reduce((s, t) => s + t.rub, 0);
      const totalMnt = completed.reduce((s, t) => s + t.mntTotal, 0);
      const totalProfit = completed.reduce((s, t) => s + (t.rate - t.costRate) * t.rub, 0);

      report += '✅ <b>MNT бүтэн хүлээн авсан:</b>\n';
      report += `Тоо: ${completed.length}\n`;
      report += `Нийт RUB: ${formatNumber(totalRub)}\n`;
      report += `Нийт MNT: ${formatNumber(totalMnt)}\n`;
      report += `Нийт ашиг: ${formatNumber(totalProfit)} MNT\n\n`;
    }

    if (pending.length) {
      report += '🟠 <b>MNT дутуу:</b>\n\n';

      let totalRemaining = 0;
      for (const t of pending) {
        totalRemaining += t.mntRemaining;

        // copy/paste бэлэн формат
        report += `№${escapeHtml(t.number)}\n`;

        report += `Назначение: ${escapeHtml(t.назначение)}\n`;

        report += `Үлдэгдэл тооцоо: <code>${formatNumber(t.mntRemaining)} MNT</code>\n\n`;
      }

      report += `Нийт хүлээгдэж буй: <b>${formatNumber(totalRemaining)} MNT</b>\n`;
    }

    if (!completed.length && !pending.length) report += 'Өнөөдөр гүйлгээ байхгүй байна.';

    await ctx.reply(report, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('❌ report:', e);
    await ctx.reply('❌ Тайлан гаргахад алдаа гарлаа.');
  }
});

bot.command('debug', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  if (chatId !== CONFIG.ALLOWED_GROUP_ID && !CONFIG.ADMIN_IDS.includes(userId)) {
    await ctx.reply('⚠️ Энэ команд зөвхөн зөвшөөрөгдсөн группт эсвэл админд ажиллана.');
    return;
  }

  let info = '🔍 <b>DEBUG</b>\n\n';
  info += `Chat ID: <code>${chatId}</code>\n`;
  info += `User ID: <code>${userId}</code>\n\n`;
  info += `Ханшийн суваг: <code>${CONFIG.RATE_CHANNEL_ID}</code>\n`;
  info += `🏦 Org: ${cachedRates.org}\n`;
  info += `👤 Person: ${cachedRates.person}\n`;
  info += `Last update: ${cachedRates.lastUpdate ? new Date(cachedRates.lastUpdate).toLocaleString('mn-MN') : 'Хэзээ ч'}\n`;

  await ctx.reply(info, { parse_mode: 'HTML' });
});

/* ================= LAUNCH (POLLING ONLY) ================= */
async function start() {
  try {
    // 409 Conflict-с 100% хамгаална
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => null);

    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message', 'callback_query', 'channel_post'],
      polling: { timeout: 30, limit: 100 },
    });

    console.log('✅ Bot running (polling)');
  } catch (e) {
    console.error('❌ start error:', e);
    process.exit(1);
  }
}

start();

/* ================= HTTP SERVER (Render port bind) ================= */
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

server.listen(CONFIG.PORT, () => {
  console.log(`✅ HTTP server listening on ${CONFIG.PORT}`);
});

/* ================= GRACEFUL STOP ================= */
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
