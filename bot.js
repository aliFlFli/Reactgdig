/**
 * ربات ری‌اکشن هوشمند تلگرام (نسخه نهایی)
 * ----------------------------------------
 * قابلیت‌ها:
 *  - تشخیص نوع پیام با اولویت‌بندی و پشتیبانی از چند دسته هم‌زمان
 *  - ذخیره تنظیمات در فایل JSON (پایدار بین اجراها)
 *  - Rate limit به ازای هر کاربر
 *  - مدیریت خطای ری‌اکشن (ری‌اکشن نامعتبر، عدم پشتیبانی، ...)
 *  - پنل مدیریت با دکمه‌های شیشه‌ای (inline keyboard) مخصوص ادمین
 *  - پشتیبانی کامل از پیام‌های کانال (channel_post) در کنار چت/گروه
 *  - آی‌دی ادمین از طریق .env (ADMIN_IDS) تنظیم می‌شود
 *
 * نکته مهم: دستورات (/start ,/status و ...) باید قبل از bot.on('message')
 * ثبت بشن، وگرنه هندلر عمومی message همه‌چیز از جمله دستورات رو می‌قاپد
 * و فقط ری‌اکشن می‌زند بدون این‌که جوابی داده بشود.
 */

const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
require('dotenv').config();
const { HelperBotManager } = require('./helper-bots');

// ==================== مسیرها ====================
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ==================== خواندن آی‌دی ادمین از .env ====================
// در .env بگذارید: ADMIN_IDS=123456789,987654321
const envAdminIds = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n !== 0);

// ==================== تنظیمات پیش‌فرض ====================
const DEFAULT_CONFIG = {
  enabled: true,
  delayMs: 0,
  ignoreUsers: [],
  rateLimit: {
    windowMs: 10000,
    maxPerWindow: 5,
  },
  reactChannelPosts: true,
  useHelperBots: true, // آیا ربات‌های کمکی هم روی پیام‌ها ری‌اکشن بزنند
  helperMaxConcurrent: null, // null = بدون سقف؛ عدد = حداکثر ربات کمکی هم‌زمان روی هر پیام
};

// ==================== مدیریت Config پایدار ====================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        rateLimit: { ...DEFAULT_CONFIG.rateLimit, ...(parsed.rateLimit || {}) },
      };
    }
  } catch (err) {
    console.error('⚠️ خطا در خواندن config.json، از تنظیمات پیش‌فرض استفاده می‌شود:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (err) {
    console.error('⚠️ خطا در ذخیره config.json:', err.message);
  }
}

let config = loadConfig();
if (!fs.existsSync(CONFIG_PATH)) saveConfig(config);

// آی‌دی ادمین‌ها همیشه از .env می‌آید (منبع واحد و امن‌تر از فایل JSON قابل‌ویرایش)
function isAdmin(userId) {
  return envAdminIds.includes(userId);
}

// ==================== دسته‌بندی و الگوهای پیام ====================
const CATEGORY_PATTERNS = [
  { name: 'thanks', regex: /ممنون|تشکر|مرسی|سپاس|قربونت|دمت گرم/i, weight: 5 },
  { name: 'love', regex: /دوست دارم|عشق|محبت|دلم|عزیزم|❤/i, weight: 5 },
  { name: 'greeting', regex: /^(سلام|درود|های|هلو|سلامت باشی)\b|صبح بخیر|شب بخیر/i, weight: 4 },
  { name: 'question', regex: /\?|؟|چطور|چگونه|چیه|چیست|کدوم|کدام|کجا|چرا|آیا/i, weight: 3 },
  { name: 'happy', regex: /خنده|خندید|خوشحال|شاد|عالیه|فوق‌العاده|😂|🎉|🔥/i, weight: 3 },
  { name: 'support', regex: /کمک|لطفا|لطفاً|لطف|ممکنه|میشه|اگه میشه/i, weight: 2 },
];

const reactions = {
  greeting: ['👋', '😊', '🙌'],
  happy: ['😂', '🎉', '❤️', '🔥'],
  support: ['👍', '💪', '🔥', '✅'],
  question: ['🤔', '❓', '💡'],
  love: ['❤️', '💕', '😍', '💖'],
  thanks: ['🙏', '❤️', '👍', '😊'],
  default: ['👍', '❤️', '🔥', '👏', '😊'],
};

function detectCategories(text) {
  if (!text) return [];
  const matched = [];
  for (const cat of CATEGORY_PATTERNS) {
    if (cat.regex.test(text)) matched.push(cat);
  }
  return matched;
}

function pickCategory(text) {
  const matched = detectCategories(text);
  if (matched.length === 0) return 'default';
  if (matched.length === 1) return matched[0].name;

  const totalWeight = matched.reduce((sum, c) => sum + c.weight, 0);
  let r = Math.random() * totalWeight;
  for (const cat of matched) {
    r -= cat.weight;
    if (r <= 0) return cat.name;
  }
  return matched[0].name;
}

function pickEmoji(category) {
  const list = reactions[category] || reactions.default;
  return list[Math.floor(Math.random() * list.length)];
}

// ==================== Rate Limiting ====================
const userReactionLog = new Map();

function isRateLimited(userId) {
  const now = Date.now();
  const { windowMs, maxPerWindow } = config.rateLimit;

  const timestamps = (userReactionLog.get(userId) || []).filter(
    (t) => now - t < windowMs
  );

  if (timestamps.length >= maxPerWindow) {
    userReactionLog.set(userId, timestamps);
    return true;
  }

  timestamps.push(now);
  userReactionLog.set(userId, timestamps);
  return false;
}

setInterval(() => {
  const now = Date.now();
  const { windowMs } = config.rateLimit;
  for (const [userId, timestamps] of userReactionLog.entries()) {
    const fresh = timestamps.filter((t) => now - t < windowMs);
    if (fresh.length === 0) userReactionLog.delete(userId);
    else userReactionLog.set(userId, fresh);
  }
}, 60_000).unref();

// ==================== راه‌اندازی ربات ====================
if (!process.env.BOT_TOKEN) {
  console.error('❌ متغیر محیطی BOT_TOKEN تنظیم نشده است. آن را در فایل .env قرار دهید.');
  process.exit(1);
}
if (envAdminIds.length === 0) {
  console.warn('⚠️ هیچ ADMIN_IDS در .env تنظیم نشده — پنل مدیریت برای هیچ‌کس در دسترس نخواهد بود.');
  console.warn('   برای گرفتن آی‌دی خودتان، ربات را استارت کنید و دستور /myid را بزنید.');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const helperBots = new HelperBotManager(config.helperMaxConcurrent);

const SAFE_FALLBACK_EMOJI = '👍';

async function safeReact(ctx, emoji) {
  try {
    await ctx.react(emoji);
    return true;
  } catch (err) {
    const desc = err?.response?.description || err.message || '';

    if (/REACTION_INVALID|invalid reaction/i.test(desc)) {
      try {
        await ctx.react(SAFE_FALLBACK_EMOJI);
        return true;
      } catch (err2) {
        console.error('❌ ری‌اکشن fallback هم شکست خورد:', err2.message);
        return false;
      }
    }

    if (typeof ctx.react !== 'function' || /REACTIONS_.*NOT_ALLOWED|not supported/i.test(desc)) {
      console.error('❌ ری‌اکشن در این چت/پیام پشتیبانی نمی‌شود:', desc || err.message);
      return false;
    }

    console.error('❌ خطای ری‌اکشن:', desc || err.message);
    return false;
  }
}

async function handleReactable(ctx, message, fromId, fromLabel) {
  if (!config.enabled) return;

  if (fromId !== null) {
    if (config.ignoreUsers.includes(fromId)) return;
    if (isRateLimited(fromId)) {
      console.log(`⏳ Rate limit برای کاربر ${fromLabel} (${fromId})`);
      return;
    }
  }

  const text = message.text || message.caption || '';
  const category = pickCategory(text);

  if (config.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.delayMs));
  }

  const emoji = pickEmoji(category);
  const ok = await safeReact(ctx, emoji);

  if (ok) {
    console.log(`✅ ${fromLabel} | دسته: ${category} | ری‌اکشن: ${emoji}`);
  }

  // ری‌اکشن ربات‌های کمکی (در صورت فعال بودن) — با تاخیر تصادفی و مستقل
  if (config.useHelperBots && helperBots.enabledBots().length > 0) {
    const emojiPool = reactions[category] || reactions.default;
    const chatId = ctx.chat.id;
    const messageId = message.message_id;
    helperBots.reactOnMessage(chatId, messageId, emojiPool);
  }
}

// ==================== پنل مدیریت شیشه‌ای ====================
function statusText() {
  return (
    `📊 *وضعیت ربات*\n\n` +
    `فعال بودن: ${config.enabled ? '✅ فعال' : '❌ غیرفعال'}\n` +
    `ری‌اکشن به کانال: ${config.reactChannelPosts ? '✅ فعال' : '❌ غیرفعال'}\n` +
    `Rate limit: ${config.rateLimit.maxPerWindow} ری‌اکشن هر ${config.rateLimit.windowMs / 1000} ثانیه\n` +
    `کاربران مستثنی: ${config.ignoreUsers.length} نفر\n` +
    `ربات‌های کمکی: ${config.useHelperBots ? '✅ فعال' : '❌ غیرفعال'} (${helperBots.enabledBots().length}/${helperBots.list().length} فعال، سقف: ${helperBots.maxConcurrent ? helperBots.maxConcurrent : 'بدون سقف'})`
  );
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        config.enabled ? '🔴 غیرفعال کردن ربات' : '🟢 فعال کردن ربات',
        'toggle_enabled'
      ),
    ],
    [
      Markup.button.callback(
        config.reactChannelPosts ? '🟠 خاموش کردن ری‌اکشن کانال' : '🔵 روشن کردن ری‌اکشن کانال',
        'toggle_channel'
      ),
    ],
    [
      Markup.button.callback('🟣 تنظیم Rate Limit', 'set_ratelimit'),
      Markup.button.callback('🟡 لیست مستثنی‌ها', 'ignore_list'),
    ],
    [
      Markup.button.callback(
        config.useHelperBots ? '🟤 خاموش کردن ربات‌های کمکی' : '🟢 روشن کردن ربات‌های کمکی',
        'toggle_helpers'
      ),
      Markup.button.callback('🔷 لیست ربات‌های کمکی', 'bots_list'),
    ],
    [Markup.button.callback('⚪️ تنظیم سقف ربات‌های کمکی', 'set_helpercap')],
    [Markup.button.callback('🔄 بروزرسانی وضعیت', 'refresh_status')],
  ]);
}

async function sendAdminPanel(ctx) {
  await ctx.reply(statusText(), {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(),
  });
}

async function editAdminPanel(ctx) {
  try {
    await ctx.editMessageText(statusText(), {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard(),
    });
  } catch (err) {
    // اگر متن تغییری نکرده بود تلگرام خطا می‌دهد؛ بی‌خطر است
    if (!/message is not modified/i.test(err.description || err.message || '')) {
      console.error('❌ خطا در ویرایش پنل:', err.message);
    }
  }
}

function requireAdminCtx(ctx) {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) {
    return false;
  }
  return true;
}

// ==================== پشتیبانی از دستورات در پست‌های کانال ====================
// bot.command() در Telegraf فقط روی آپدیت‌های نوع «message» کار می‌کند.
// وقتی خودِ ادمین مستقیماً در کانال یک دستور (/panel ,/bots و ...) می‌فرستد،
// تلگرام آن را به شکل «channel_post» تحویل می‌دهد، نه «message» — پس
// bot.command() هرگز آن را نمی‌بیند و فقط هندلر عمومی channel_post
// (که فقط ری‌اکشن می‌زند) اجرا می‌شود. این میان‌افزار قبل از هر چیز
// دستورهای متنی داخل channel_post را تشخیص می‌دهد و به همان تابع
// dispatch می‌کند که برای message استفاده می‌شود.
const channelCommandHandlers = new Map();

function registerChannelCommand(name, handler) {
  channelCommandHandlers.set(name, handler);
}

bot.on('channel_post', async (ctx, next) => {
  const text = ctx.channelPost.text || '';
  if (!text.startsWith('/')) return next();

  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?(?:\s+(.*))?$/s);
  if (!match) return next();

  const [, cmdName, args] = match;
  const handler = channelCommandHandlers.get(cmdName);
  if (!handler) return next(); // دستور ناشناخته در کانال؛ به بقیه هندلرها بسپار

  // نکته مهم: تلگرام در آپدیت‌های channel_post معمولاً ctx.from را پر
  // نمی‌کند (پست از طرف «هویت کانال» است، نه اکانت شخصی) — پس تشخیص
  // ادمین بر مبنای userId اینجا کار نمی‌کند، حتی اگر خودِ ادمین فرستاده
  // باشد. برای دستورات مدیریتی، به‌جای تلاش نافرجام، پیام راهنما بده.
  if (!ctx.from?.id) {
    await ctx.reply(
      '⚠️ دستورات مدیریتی را نمی‌توان مستقیماً داخل خودِ کانال اجرا کرد ' +
        '(تلگرام هویت فرستنده را در پست‌های کانال نشان نمی‌دهد).\n' +
        'لطفاً همین دستور را در چت خصوصی با ربات بفرستید.'
    );
    return; // next() صدا زده نمی‌شود تا ری‌اکشن هم نخورد
  }

  ctx.message = { text, message_id: ctx.channelPost.message_id };
  try {
    await handler(ctx, args || '');
  } catch (err) {
    console.error(`❌ خطا در اجرای دستور کانال /${cmdName}:`, err.message);
  }
  // عمداً next() صدا زده نمی‌شود تا هندلر عمومی channel_post (ری‌اکشن) روی
  // خود دستور اجرا نشود.
});

// ==================== دستورات (باید قبل از bot.on('message') ثبت شوند) ====================

bot.command('start', async (ctx) => {
  await ctx.reply(
    '🤖 سلام! من یک ربات ری‌اکشن خودکار هستم.\n' +
      'هر پیامی که در چت یا کانال ارسال بشه (اگه ادمین کانال باشم) یک ری‌اکشن دریافت می‌کنه!\n\n' +
      'برای دیدن آی‌دی عددی خودتان: /myid'
  );
});

bot.command('myid', async (ctx) => {
  await ctx.reply(`آی‌دی شما: ${ctx.from.id}`);
});

// دستور تست ساده و بدون هیچ منطق اضافه — برای اطمینان از این‌که مسیر
// دستورات اصلاً به bot می‌رسد (اگر این هم جواب نداد، مشکل از سطح
// شبکه/توکن/پولینگ است، نه منطق برنامه)
bot.command('ping', async (ctx) => {
  await ctx.reply('pong ✅');
});
registerChannelCommand('ping', async (ctx) => {
  await ctx.reply('pong ✅ (از کانال)');
});

bot.command('status', async (ctx) => {
  await ctx.reply(statusText(), { parse_mode: 'Markdown' });
});
registerChannelCommand('status', async (ctx) => {
  await ctx.reply(statusText(), { parse_mode: 'Markdown' });
});

// پنل مدیریت با دکمه‌های شیشه‌ای — فقط ادمین
bot.command('panel', async (ctx) => {
  if (!requireAdminCtx(ctx)) {
    return ctx.reply('⛔️ این دستور فقط برای ادمین در دسترس است.');
  }
  await sendAdminPanel(ctx);
});
registerChannelCommand('panel', async (ctx) => {
  if (!requireAdminCtx(ctx)) {
    return ctx.reply('⛔️ این دستور فقط برای ادمین در دسترس است.');
  }
  await sendAdminPanel(ctx);
});

// تابع کمکی: یک هندلر را هم برای پیام معمولی (bot.command) و هم برای
// دستور داخل پست کانال (registerChannelCommand) با یک تعریف واحد ثبت می‌کند.
function dualCommand(name, handler) {
  bot.command(name, handler);
  registerChannelCommand(name, handler);
}

// افزودن/حذف کاربر مستثنی
dualCommand('ignore', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.reply('⛔️ فقط ادمین.');
  const parts = ctx.message.text.split(/\s+/);
  const targetId = Number(parts[1]);
  if (!targetId) return ctx.reply('استفاده صحیح: /ignore <user_id>');
  if (!config.ignoreUsers.includes(targetId)) {
    config.ignoreUsers.push(targetId);
    saveConfig(config);
  }
  await ctx.reply(`✅ کاربر ${targetId} به لیست مستثنی اضافه شد.`);
});

dualCommand('unignore', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.reply('⛔️ فقط ادمین.');
  const parts = ctx.message.text.split(/\s+/);
  const targetId = Number(parts[1]);
  if (!targetId) return ctx.reply('استفاده صحیح: /unignore <user_id>');
  config.ignoreUsers = config.ignoreUsers.filter((id) => id !== targetId);
  saveConfig(config);
  await ctx.reply(`✅ کاربر ${targetId} از لیست مستثنی حذف شد.`);
});

// ==================== ربات‌های کمکی ====================

dualCommand('addbot', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.reply('⛔️ فقط ادمین.');
  const parts = ctx.message.text.trim().split(/\s+/);
  const token = parts[1];
  if (!token) {
    return ctx.reply('استفاده صحیح: /addbot <token>\n(توکن را از @BotFather بگیرید)');
  }

  // حذف پیام حاوی توکن برای امنیت بیشتر (در گروه/کانال باقی نماند)
  ctx.deleteMessage().catch(() => {});

  try {
    const meta = await helperBots.addBot(token);
    await ctx.reply(
      `✅ ربات کمکی اضافه شد: ${meta.label} (id: ${meta.id})\n\n` +
        '⚠️ یادت نره این ربات رو هم باید در کانال/گروه *ادمین* کنی تا بتونه ری‌اکشن بزنه.',
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await ctx.reply(`❌ خطا: ${err.message}`);
  }
});

dualCommand('bots', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.reply('⛔️ فقط ادمین.');
  const list = helperBots.list();
  if (list.length === 0) {
    return ctx.reply('هیچ ربات کمکی‌ای اضافه نشده است.\nبرای افزودن: /addbot <token>');
  }
  const lines = list.map(
    (b) => `${b.enabled ? '🟢' : '⚪️'} ${b.label} — id: \`${b.id}\``
  );
  const capText = helperBots.maxConcurrent ? `حداکثر ${helperBots.maxConcurrent} تا هم‌زمان` : 'بدون سقف (همه‌ی فعال‌ها)';
  await ctx.reply(
    `🤖 *ربات‌های کمکی* (${list.length} عدد، ${capText} روی هر پیام):\n\n` +
      lines.join('\n') +
      '\n\nبرای حذف: /removebot <id>\nحالت کلی ربات‌های کمکی: /togglehelpers\nتنظیم سقف: /sethelpercap <عدد یا 0 برای بدون‌سقف>',
    { parse_mode: 'Markdown' }
  );
});

dualCommand('removebot', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.reply('⛔️ فقط ادمین.');
  const parts = ctx.message.text.trim().split(/\s+/);
  const id = parts[1];
  if (!id) return ctx.reply('استفاده صحیح: /removebot <id>');

  const removed = helperBots.removeBot(id);
  await ctx.reply(removed ? `✅ ربات ${id} حذف شد.` : `❌ رباتی با آی‌دی ${id} پیدا نشد.`);
});

dualCommand('togglehelpers', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.reply('⛔️ فقط ادمین.');
  config.useHelperBots = !config.useHelperBots;
  saveConfig(config);
  await ctx.reply(
    `ری‌اکشن ربات‌های کمکی ${config.useHelperBots ? '✅ فعال' : '❌ غیرفعال'} شد.`
  );
});

dualCommand('sethelpercap', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.reply('⛔️ فقط ادمین.');
  const parts = ctx.message.text.trim().split(/\s+/);
  const raw = parts[1];
  if (raw === undefined) {
    return ctx.reply('استفاده صحیح: /sethelpercap <عدد>  (یا 0 برای بدون‌سقف)');
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return ctx.reply('عدد نامعتبر است. مثال: /sethelpercap 5  یا  /sethelpercap 0');
  }
  const capValue = n === 0 ? null : n;
  config.helperMaxConcurrent = capValue;
  saveConfig(config);
  helperBots.setMaxConcurrent(capValue);
  await ctx.reply(
    capValue ? `✅ سقف تنظیم شد: حداکثر ${capValue} ربات کمکی هم‌زمان روی هر پیام.` : '✅ سقف برداشته شد — همه‌ی ربات‌های فعال روی هر پیام ری‌اکشن می‌زنند.'
  );
});

// ==================== اکشن‌های دکمه‌های شیشه‌ای ====================

bot.action('toggle_enabled', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.answerCbQuery('⛔️ فقط ادمین.', { show_alert: true });
  config.enabled = !config.enabled;
  saveConfig(config);
  await ctx.answerCbQuery(config.enabled ? '✅ ربات فعال شد' : '⏸ ربات غیرفعال شد');
  await editAdminPanel(ctx);
});

bot.action('toggle_channel', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.answerCbQuery('⛔️ فقط ادمین.', { show_alert: true });
  config.reactChannelPosts = !config.reactChannelPosts;
  saveConfig(config);
  await ctx.answerCbQuery(config.reactChannelPosts ? '📡 روشن شد' : '📴 خاموش شد');
  await editAdminPanel(ctx);
});

bot.action('refresh_status', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.answerCbQuery('⛔️ فقط ادمین.', { show_alert: true });
  await ctx.answerCbQuery('🔄 بروز شد');
  await editAdminPanel(ctx);
});

bot.action('toggle_helpers', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.answerCbQuery('⛔️ فقط ادمین.', { show_alert: true });
  config.useHelperBots = !config.useHelperBots;
  saveConfig(config);
  await ctx.answerCbQuery(config.useHelperBots ? '🤖 روشن شد' : '🤖 خاموش شد');
  await editAdminPanel(ctx);
});

bot.action('bots_list', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.answerCbQuery('⛔️ فقط ادمین.', { show_alert: true });
  await ctx.answerCbQuery();
  const list = helperBots.list();
  const text =
    list.length === 0
      ? '🤖 هیچ ربات کمکی‌ای اضافه نشده است.\n\nبرای افزودن: `/addbot <token>`'
      : `🤖 *ربات‌های کمکی* (${list.length} عدد):\n\n` +
        list.map((b) => `${b.enabled ? '🟢' : '⚪️'} ${b.label} — id: \`${b.id}\``).join('\n') +
        '\n\nحذف: `/removebot <id>`';
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.action('set_helpercap', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.answerCbQuery('⛔️ فقط ادمین.', { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.reply(
    `⚪️ سقف فعلی: ${helperBots.maxConcurrent ? helperBots.maxConcurrent + ' ربات هم‌زمان' : 'بدون سقف'}\n\nیک گزینه انتخاب کن:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🔹 ۲ ربات', 'hc_2'),
        Markup.button.callback('🔸 ۵ ربات', 'hc_5'),
      ],
      [
        Markup.button.callback('🔶 ۱۰ ربات', 'hc_10'),
        Markup.button.callback('⭐️ بدون سقف', 'hc_0'),
      ],
      [Markup.button.callback('« بازگشت به پنل', 'refresh_status')],
    ])
  );
});

bot.action(/^hc_(\d+)$/, async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.answerCbQuery('⛔️ فقط ادمین.', { show_alert: true });
  const n = Number(ctx.match[1]);
  const capValue = n === 0 ? null : n;
  config.helperMaxConcurrent = capValue;
  saveConfig(config);
  helperBots.setMaxConcurrent(capValue);
  await ctx.answerCbQuery(capValue ? `✅ سقف: ${capValue} ربات` : '✅ بدون سقف');
  await ctx.deleteMessage().catch(() => {});
  await sendAdminPanel(ctx);
});

bot.action('ignore_list', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.answerCbQuery('⛔️ فقط ادمین.', { show_alert: true });
  await ctx.answerCbQuery();
  const list =
    config.ignoreUsers.length === 0
      ? 'خالی است.'
      : config.ignoreUsers.map((id) => `• ${id}`).join('\n');
  await ctx.reply(
    `🚫 *کاربران مستثنی*\n\n${list}\n\n` +
      'برای افزودن: `/ignore user_id`\n' +
      'برای حذف: `/unignore user_id`',
    { parse_mode: 'Markdown' }
  );
});

// جریان ساده برای تنظیم rate limit با دکمه‌های عدد ثابت (بدون نیاز به state پیچیده)
bot.action('set_ratelimit', async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.answerCbQuery('⛔️ فقط ادمین.', { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.reply(
    '⏱ یک گزینه را انتخاب کنید (تعداد ری‌اکشن مجاز در بازه):',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('۳ در ۱۰ ثانیه', 'rl_3_10'),
        Markup.button.callback('۵ در ۱۰ ثانیه', 'rl_5_10'),
      ],
      [
        Markup.button.callback('۱۰ در ۶۰ ثانیه', 'rl_10_60'),
        Markup.button.callback('۲۰ در ۶۰ ثانیه', 'rl_20_60'),
      ],
      [Markup.button.callback('« بازگشت به پنل', 'refresh_status')],
    ])
  );
});

bot.action(/^rl_(\d+)_(\d+)$/, async (ctx) => {
  if (!requireAdminCtx(ctx)) return ctx.answerCbQuery('⛔️ فقط ادمین.', { show_alert: true });
  const max = Number(ctx.match[1]);
  const seconds = Number(ctx.match[2]);
  config.rateLimit.maxPerWindow = max;
  config.rateLimit.windowMs = seconds * 1000;
  saveConfig(config);
  await ctx.answerCbQuery(`✅ تنظیم شد: ${max} در ${seconds} ثانیه`);
  await ctx.deleteMessage().catch(() => {});
  await sendAdminPanel(ctx);
});

// ==================== هندلرهای عمومی پیام (بعد از دستورات ثبت می‌شوند) ====================

bot.on('message', async (ctx) => {
  try {
    // اگر پیام یک دستور است (با / شروع می‌شود)، هرگز به آن ری‌اکشن نزن.
    // این هم از تداخل با هندلرهای bot.command جلوگیری می‌کند و هم
    // منطقی‌تر است (به دستورات ادمین نباید ری‌اکشن زد).
    const rawText = ctx.message.text || '';
    if (rawText.startsWith('/')) return;

    await handleReactable(
      ctx,
      ctx.message,
      ctx.from?.id ?? null,
      ctx.from?.first_name || ctx.from?.username || `id:${ctx.from?.id}`
    );
  } catch (error) {
    console.error('❌ خطا در پردازش پیام:', error.message);
  }
});

bot.on('channel_post', async (ctx) => {
  try {
    if (!config.reactChannelPosts) return;
    await handleReactable(ctx, ctx.channelPost, null, `کانال:${ctx.chat?.title || ctx.chat?.id}`);
  } catch (error) {
    console.error('❌ خطا در پردازش پست کانال:', error.message);
  }
});

// ==================== راه‌اندازی و خاموشی امن ====================

// گرفتن هر خطایی که در هندلرها رخ دهد و در ترمینال نمایش آن — بدون این
// خطاهای داخل هندلرهای async ممکن است بی‌صدا بلعیده شوند.
bot.catch((err, ctx) => {
  console.error(`❌ خطای مدیریت‌نشده در آپدیت نوع ${ctx.updateType}:`, err.message);
});

bot.launch();
console.log('🤖 ربات شروع شد!');
console.log(`   حالت: ${config.enabled ? 'فعال' : 'غیرفعال'}`);
console.log(`   ری‌اکشن به کانال: ${config.reactChannelPosts ? 'فعال' : 'غیرفعال'}`);
console.log(`   ادمین‌ها: ${envAdminIds.length > 0 ? envAdminIds.join(', ') : '(تنظیم نشده)'}`);
console.log(`   ربات‌های کمکی: ${helperBots.list().length} عدد (${helperBots.maxConcurrent ? 'حداکثر ' + helperBots.maxConcurrent + ' هم‌زمان' : 'بدون سقف'})`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
