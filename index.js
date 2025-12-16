const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const http = require('http');

// ========== CONFIG ==========
const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN
  SPREADSHEET_ID: process.env.SPREADSHEET_ID
  RATE_CHANNEL_ID: '-1003355216653',
  ALLOWED_GROUP_ID: -5069100118,
  ADMIN_IDS: [1447446407, 1920453419],
  PORT: process.env.PORT 
  
  GOOGLE_CREDENTIALS: {
    "type": "service_account",
    "project_id": "your-project-id",
    "private_key_id": "your-private-key-id",
    "private_key": "-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n",
    "client_email": "your-service-account@your-project.iam.gserviceaccount.com",
    "client_id": "your-client-id",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_x509_cert_url": "your-cert-url"
  }
};

const bot = new Telegraf(CONFIG.BOT_TOKEN);

// ========== GOOGLE SHEETS ==========
const auth = new google.auth.GoogleAuth({
  credentials: CONFIG.GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SHEET_NAME = 'Transactions2';

let sheetsLock = Promise.resolve();
const lockSheets = (fn) => {
  sheetsLock = sheetsLock.then(fn).catch(fn);
  return sheetsLock;
};

// ========== STATE ==========
const transactionStates = new Map();
let cachedRates = { org: 45.10, person: 45.20, lastUpdate: 0 };

// ========== HELPERS ==========
function parseNumber(str) {
  if (!str) return 0;
  return parseFloat(str.toString().replace(/[,\s]/g, '').trim()) || 0;
}

function formatNumber(num) {
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCalculation(rub, commission, rubTotal, rate, mntTotal, mntReceived = null) {
  let calc = `<pre>`;
  calc += `+  ${formatNumber(rub).padStart(13)}\n`;
  calc += `+  ${formatNumber(commission).padStart(13)}\n`;
  calc += `${'-'.repeat(15)}\n`;
  calc += `+  ${formatNumber(rubTotal).padStart(13)}\n`;
  calc += `*  ${formatNumber(rate).padStart(13)}\n`;
  calc += `${'-'.repeat(15)}\n`;
  calc += `+  ${formatNumber(mntTotal).padStart(13)}\n`;
  
  if (mntReceived !== null && mntReceived > 0) {
    calc += `-  ${formatNumber(mntReceived).padStart(13)}\n`;
    calc += `${'-'.repeat(15)}\n`;
    calc += `+  ${formatNumber(mntTotal - mntReceived).padStart(13)}\n`;
  }
  
  calc += `</pre>`;
  return calc;
}

// ========== GOOGLE SHEETS OPS ==========
async function appendTransaction(data) {
  return lockSheets(async () => {
    const values = [[
      data.number, data.date, data.назначение, data.rub, data.rate,
      data.commission, data.rubTotal, data.mntTotal, data.mntReceived || 0,
      data.mntRemaining, data.status, data.startedAt, data.completedAt || '',
      data.minutes || '', data.chatId, data.txMessageId, data.calcMessageId || '',
      data.rateType || '', data.costRate || ''
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:S`,
      valueInputOption: 'USER_ENTERED',
      resource: { values }
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
    if (rows[i][15] == txMessageId && rows[i][14] == chatId) return i + 1;
  }
  return null;
}

async function updateTransaction(rowNum, updates) {
  return lockSheets(async () => {
    const cols = {
      'number': 0, 'date': 1, 'назначение': 2, 'rub': 3, 'rate': 4,
      'commission': 5, 'rubTotal': 6, 'mntTotal': 7, 'mntReceived': 8,
      'mntRemaining': 9, 'status': 10, 'startedAt': 11, 'completedAt': 12,
      'minutes': 13, 'chatId': 14, 'txMessageId': 15, 'calcMessageId': 16,
      'rateType': 17, 'costRate': 18
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

async function getTodayTransactions() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:S`
  });

  const rows = response.data.values || [];
  const today = new Date().toISOString().split('T')[0];
  
  const transactions = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const date = row[1] ? row[1].split('T')[0] : '';
    if (date === today) {
      transactions.push({
        number: row[0],
        назначение: row[2],
        rub: parseNumber(row[3]),
        rate: parseNumber(row[4]),
        mntTotal: parseNumber(row[7]),
        mntRemaining: parseNumber(row[9]),
        status: row[10],
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
    if (ctx.channelPost.chat.id != CONFIG.RATE_CHANNEL_ID || !ctx.channelPost.text) return;
    
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

// ========== HELPERS ==========
function findStateByTxId(chatId, txMessageId) {
  for (const [key, state] of transactionStates.entries()) {
    if (key.includes(`${chatId}_`) && state.txMessageId == txMessageId) return state;
  }
  return null;
}

function findActiveState(chatId) {
  for (const [key, state] of transactionStates.entries()) {
    if (key.startsWith(`${chatId}_`)) return state;
  }
  return null;
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

// ========== TEXT HANDLER ==========
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const messageId = ctx.message.message_id;
  const text = ctx.message.text;

  if (chatId !== CONFIG.ALLOWED_GROUP_ID && !CONFIG.ADMIN_IDS.includes(ctx.from.id)) return;
  if (text.startsWith('/')) return;

  // 1) ШИНЭ ГҮЙЛГЭЭ - "назначение" болон "сумма" гэсэн үг орсон бол таних
  const numberMatch = text.match(/^(\d+)\./m);
  const назначениеMatch = text.match(/назначени[её][^:]*:\s*(.+)/im);
  const суммаMatch = text.match(/сумма:\s*([\d,.\s]+)/im);

  if (numberMatch && назначениеMatch && суммаMatch) {
    const number = numberMatch[1];
    const назначение = назначениеMatch[1].trim();
    const rub = parseNumber(суммаMatch[1]);

    console.log(`✅ Гүйлгээ: №${number}, ${rub} RUB`);

    const stateKey = `${chatId}_${messageId}`;
    transactionStates.set(stateKey, {
      number, назначение, rub, chatId, txMessageId: messageId,
      step: 'waiting_cost_rate',
      startedAt: new Date().toISOString()
    });

    await ctx.reply('💰 <b>Өртөг ханш оруулна уу:</b>', {
      reply_to_message_id: messageId, parse_mode: 'HTML'
    });
    return;
  }

  // 2) REPLY ХАРИУЛТ
  const activeState = findActiveState(chatId);
  if (!activeState) return;

  if (activeState.step === 'waiting_cost_rate') {
    const costRate = parseNumber(text);
    if (costRate > 0) {
      activeState.costRate = costRate;
      activeState.step = 'waiting_sell_rate';
      
      const rates = await fetchLatestRates();
      await ctx.reply('📊 <b>Зарах ханш сонгоно уу:</b>', {
        reply_to_message_id: activeState.txMessageId, parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`🏦 ${rates.org.toFixed(2)}`, `rate_org_${activeState.txMessageId}`),
            Markup.button.callback(`👤 ${rates.person.toFixed(2)}`, `rate_person_${activeState.txMessageId}`)
          ],
          [Markup.button.callback('✍️ Өөр ханш оруулах', `rate_custom_${activeState.txMessageId}`)]
        ])
      });
    }
    return;
  }

  if (activeState.step === 'waiting_custom_rate') {
    const customRate = parseNumber(text);
    if (customRate > 0) {
      activeState.rate = customRate;
      activeState.rateType = 'Өөр';
      await processCommission(ctx, activeState);
    }
    return;
  }

  if (activeState.step === 'waiting_commission') {
    const commission = parseNumber(text);
    if (commission > 0) {
      activeState.commission = commission;
      await showCalculation(ctx, activeState);
    }
    return;
  }

  if (activeState.step === 'waiting_partial_mnt') {
    const mnt = parseNumber(text);
    if (mnt > 0) {
      activeState.mntReceived = (activeState.mntReceived || 0) + mnt;
      activeState.mntRemaining = activeState.mntTotal - activeState.mntReceived;
      
      const rowNum = await findTransactionRow(activeState.txMessageId, chatId);
      if (rowNum) {
        await updateTransaction(rowNum, {
          'mntReceived': activeState.mntReceived,
          'mntRemaining': activeState.mntRemaining,
          'status': activeState.mntRemaining <= 0 ? 'Амжилттай' : 'Хэсэгчлэн орсон'
        });
      }
      
      const calc = formatCalculation(activeState.rub, activeState.commission, activeState.rubTotal, activeState.rate, activeState.mntTotal, activeState.mntReceived);
      
      await ctx.reply(`✅ <b>Хэсэгчлэн орлоо:</b> ${formatNumber(mnt)} MNT\n\n${calc}`, { parse_mode: 'HTML' });
      
      if (activeState.mntRemaining <= 0) {
        const completedAt = new Date().toISOString();
        const minutes = Math.round((new Date(completedAt) - new Date(activeState.startedAt)) / 60000);
        
        if (rowNum) {
          await updateTransaction(rowNum, { 'completedAt': completedAt, 'minutes': minutes, 'status': 'Амжилттай' });
        }
        
        await ctx.reply('🎉 <b>Гүйлгээ амжилттай хаагдлаа!</b>', { parse_mode: 'HTML' });
        transactionStates.delete(`${chatId}_${activeState.txMessageId}`);
      } else {
        activeState.step = 'waiting_confirmation';
        await ctx.reply('💵 <b>MNT бүтэн орсон уу?</b>', {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Бүтэн орсон', `confirm_full_${activeState.txMessageId}`)],
            [Markup.button.callback('🟠 Дахин хэсэгчлэн орсон', `confirm_partial_${activeState.txMessageId}`)]
          ])
        });
      }
    }
    return;
  }
});

// ========== CALLBACK HANDLERS ==========
bot.action(/rate_(org|person|custom)_(.+)/, async (ctx) => {
  const [, type, txMessageId] = ctx.match;
  const state = findStateByTxId(ctx.chat.id, txMessageId);
  if (!state) return;
  
  const rates = await fetchLatestRates();
  
  if (type === 'org') {
    state.rate = rates.org;
    state.rateType = 'Байгууллага';
    await ctx.answerCbQuery('🏦 Сонгогдлоо');
    await processCommission(ctx, state);
  } else if (type === 'person') {
    state.rate = rates.person;
    state.rateType = 'Хувь хүн';
    await ctx.answerCbQuery('👤 Сонгогдлоо');
    await processCommission(ctx, state);
  } else {
    state.step = 'waiting_custom_rate';
    await ctx.answerCbQuery();
    await ctx.reply('✍️ <b>Зарах ханш оруулна уу:</b>', { parse_mode: 'HTML', reply_to_message_id: state.txMessageId });
  }
});

bot.action(/change_commission_(.+)/, async (ctx) => {
  const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
  if (!state) return;
  
  state.step = 'waiting_commission';
  await ctx.answerCbQuery();
  await ctx.reply('💰 <b>Шимтгэл оруулна уу:</b>', { parse_mode: 'HTML', reply_to_message_id: state.calcMessageId });
});

bot.action(/change_rate_(.+)/, async (ctx) => {
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
});

bot.action(/confirm_transaction_(.+)/, async (ctx) => {
  const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
  if (!state) return;
  
  await ctx.answerCbQuery();
  
  const rowNum = await findTransactionRow(state.txMessageId, ctx.chat.id);
  if (!rowNum) {
    await appendTransaction({
      number: state.number, date: new Date().toISOString(), назначение: state.назначение,
      rub: state.rub, rate: state.rate, commission: state.commission, rubTotal: state.rubTotal,
      mntTotal: state.mntTotal, mntReceived: 0, mntRemaining: state.mntTotal,
      status: 'Хүлээгдэж буй', startedAt: state.startedAt, chatId: state.chatId,
      txMessageId: state.txMessageId, calcMessageId: state.calcMessageId,
      rateType: state.rateType, costRate: state.costRate
    });
  }
  
  state.step = 'waiting_confirmation';
  await ctx.reply('💵 <b>MNT бүтэн орсон уу?</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Бүтэн орсон', `confirm_full_${ctx.match[1]}`)],
      [Markup.button.callback('🟠 Хэсэгчлэн орсон', `confirm_partial_${ctx.match[1]}`)]
    ])
  });
});

bot.action(/confirm_full_(.+)/, async (ctx) => {
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
      'mntReceived': state.mntTotal, 'mntRemaining': 0,
      'status': 'Амжилттай', 'completedAt': completedAt, 'minutes': minutes
    });
  }
  
  await ctx.editMessageText('🎉 <b>Гүйлгээ амжилттай хаагдлаа!</b>', { parse_mode: 'HTML' });
  transactionStates.delete(`${ctx.chat.id}_${ctx.match[1]}`);
});

bot.action(/confirm_partial_(.+)/, async (ctx) => {
  const state = findStateByTxId(ctx.chat.id, ctx.match[1]);
  if (!state) return;
  
  await ctx.answerCbQuery();
  state.step = 'waiting_partial_mnt';
  await ctx.reply('💸 <b>Ороод ирсэн MNT дүнг оруулна уу:</b>', {
    parse_mode: 'HTML', reply_to_message_id: state.calcMessageId || state.txMessageId
  });
});

// ========== COMMANDS ==========
bot.command('report', async (ctx) => {
  if (ctx.chat.id !== CONFIG.ALLOWED_GROUP_ID) return;
  
  try {
    const transactions = await getTodayTransactions();
    const completed = transactions.filter(t => t.status === 'Амжилттай');
    const pending = transactions.filter(t => t.status !== 'Амжилттай');
    
    let report = '📊 <b>ӨНӨӨДРИЙН ТАЙЛАН</b>\n\n';
    
    if (completed.length > 0) {
      const totalRub = completed.reduce((s, t) => s + t.rub, 0);
      const totalMnt = completed.reduce((s, t) => s + t.mntTotal, 0);
      const totalProfit = completed.reduce((s, t) => s + (t.rate - t.costRate) * t.rub, 0);
      
      report += '✅ <b>MNT бүтэн орсон:</b>\n';
      report += `   Тоо: ${completed.length}\n`;
      report += `   Нийт RUB: ${formatNumber(totalRub)}\n`;
      report += `   Нийт MNT: ${formatNumber(totalMnt)}\n`;
      report += `   Нийт ашиг: ${formatNumber(totalProfit)} MNT\n\n`;
    }
    
    if (pending.length > 0) {
      report += '🟠 <b>MNT дутуу орсон:</b>\n<pre>';
      let totalRemaining = 0;
      pending.forEach(t => {
        report += `${t.number}. ${t.назначение.substring(0, 20)}... - ${formatNumber(t.mntRemaining)}\n`;
        totalRemaining += t.mntRemaining;
      });
      report += `</pre>\n   Нийт хүлээгдэж буй: ${formatNumber(totalRemaining)} MNT\n`;
    }
    
    if (!completed.length && !pending.length) report += 'Өнөөдөр гүйлгээ байхгүй байна.';
    
    await ctx.reply(report, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Report error:', err);
    await ctx.reply('❌ Тайлан гаргахад алдаа гарлаа.');
  }
});

bot.command('debug', async (ctx) => {
  let info = '🔍 <b>DEBUG</b>\n\n';
  info += `💬 Chat ID: <code>${ctx.chat.id}</code>\n`;
  info += `👤 User ID: <code>${ctx.from.id}</code>\n\n`;
  info += `💰 Ханш:\n`;
  info += `- 🏦 Байгууллага: ${cachedRates.org}\n`;
  info += `- 👤 Хувь хүн: ${cachedRates.person}\n`;
  
  const isAllowed = ctx.chat.id === CONFIG.ALLOWED_GROUP_ID || CONFIG.ADMIN_IDS.includes(ctx.from.id);
  info += `\n${isAllowed ? '✅' : '❌'} Бот ${isAllowed ? 'ажиллана' : 'ажиллахгүй'}`;
  
  await ctx.reply(info, { parse_mode: 'HTML' });
});

// ========== SERVER ==========
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OYUNS Bot is running!');
});

server.listen(CONFIG.PORT, () => {
  console.log(`✅ Server: port ${CONFIG.PORT}`);
});

// ========== BOT LAUNCH ==========
async function startBot() {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    
    await bot.launch({
      allowedUpdates: ['message', 'callback_query', 'channel_post'],
      dropPendingUpdates: true
    });
    
    console.log('✅ Bot эхэллээ!');
    console.log(`💰 Ханш: 🏦 ${cachedRates.org} | 👤 ${cachedRates.person}`);
  } catch (err) {
    console.error('❌ Bot launch:', err);
    process.exit(1);
  }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));