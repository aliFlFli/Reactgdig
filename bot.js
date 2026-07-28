/**
 * ربات ری‌اکشن هوشمند (نسخه ارتقایافته)
 * ------------------------------------
 * قابلیت‌ها:
 *  - تشخیص نوع پیام با اولویت‌بندی و پشتیبانی از چند دسته هم‌زمان
 *  - ذخیره تنظیمات در فایل JSON (پایدار بین اجراها)
 *  - Rate limit به ازای هر کاربر
 *  - مدیریت خطای ری‌اکشن (ری‌اکشن نامعتبر، عدم پشتیبانی، ...)
 *  - دستورات ادمین برای مدیریت لیست کاربران مستثنی
 *  - پشتیبانی کامل از پیام‌های کانال (channel_post) در کنار چت/گروه
 */

const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
require('dotenv').config();

// ==================== مسیرها ====================
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ==================== تنظیمات پیش‌فرض ====================
const DEFAULT_CONFIG = {
  enabled: true,
  delayMs: 0,
  maxReactions: 1,
  ignoreUsers: [],       // آی‌دی کاربران مستثنی (برای پیام‌های چت/گروه)
  adminIds: [],          // آی‌دی ادمین‌هایی که مجاز به اجرای دستورات مدیریتی هستند
  rateLimit: {
    windowMs: 10000,     // بازه زمانی (میلی‌ثانیه)
    maxPerWindow: 5,     // حداکثر تعداد ری‌اکشن مجاز در بازه، برای هر کاربر
  },
  reactChannelPosts: true, // آیا به پست‌های کانال هم ری‌اکشن بزند
};

// ==================== مدیریت Config پایدار ====================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      // ادغام با پیش‌فرض‌ها تا فیلدهای جدید هم موجود باشن
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
// اگر فایل وجود نداشت، همین اول بسازیمش
if (!fs.existsSync(CONFIG_PATH)) saveConfig(config);

// ==================== دسته‌بندی و الگوهای پیام ====================
// ترتیب این آرایه = اولویت تشخیص (اولی بالاترین اولویت)
// هر دسته می‌تواند هم‌زمان با بقیه تشخیص داده شود؛ اما برای انتخاب نهایی emoji
// از دسته با بالاترین اولویت که match شده استفاده می‌کنیم مگر اینکه چند دسته
// با اهمیت نزدیک هم‌زمان match بشن که در آن صورت به‌صورت تصادفی وزن‌دار انتخاب می‌شود.
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

/**
 * تشخیص همه دسته‌های match شده در متن، مرتب‌شده بر اساس اولویت.
 * خروجی: آرایه‌ای از نام دسته‌ها (می‌تواند خالی باشد).
 */
function detectCategories(text) {
  if (!text) return [];
  const matched = [];
  for (const cat of CATEGORY_PATTERNS) {
    if (cat.regex.test(text)) matched.push(cat);
  }
  return matched;
}

/**
 * انتخاب نهایی دسته: اگر چند دسته match شدن، بر اساس وزن (تصادفی وزن‌دار) انتخاب می‌کنیم.
 * اگر هیچ دسته‌ای match نشد، 'default' برمی‌گردد.
 */
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
// نگاشت userId -> آرایه‌ی timestamp های ری‌اکشن‌های اخیر
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

// پاکسازی دوره‌ای حافظه rate limit برای جلوگیری از نشت حافظه
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

const bot = new Telegraf(process.env.BOT_TOKEN);

function isAdmin(userId) {
  return config.adminIds.includes(userId);
}

/**
 * تلاش برای ری‌اکشن با مدیریت خطای مخصوص:
 * - اگر ایموجی مجاز نبود (تلگرام لیست محدودی از ایموجی‌های ری‌اکشن را می‌پذیرد)
 *   با یک ایموجی fallback امن دوباره تلاش می‌کند.
 * - اگر متد react اصلاً پشتیبانی نشود (نسخه قدیمی API / نوع چت نامعتبر) خطا را
 *   لاگ می‌کند بدون کرش کردن کل پردازش پیام.
 */
const SAFE_FALLBACK_EMOJI = '👍';

async function safeReact(ctx, emoji) {
  try {
    await ctx.react(emoji);
    return true;
  } catch (err) {
    const desc = err?.response?.description || err.message || '';

    // ایموجی نامعتبر/غیرمجاز برای ری‌اکشن
    if (/REACTION_INVALID|invalid reaction/i.test(desc)) {
      try {
        await ctx.react(SAFE_FALLBACK_EMOJI);
        return true;
      } catch (err2) {
        console.error('❌ ری‌اکشن fallback هم شکست خورد:', err2.message);
        return false;
      }
    }

    // متد react پشتیبانی نمی‌شود (مثلاً نوع chat نامعتبر یا نسخه API قدیمی)
    if (typeof ctx.react !== 'function' || /REACTIONS_.*NOT_ALLOWED|not supported/i.test(desc)) {
      console.error('❌ ری‌اکشن در این چت/پیام پشتیبانی نمی‌شود:', desc || err.message);
      return false;
    }

    console.error('❌ خطای ری‌اکشن:', desc || err.message);
    return false;
  }
}

/**
 * پردازش مشترک برای پیام معمولی و پیام کانال
 */
async function handleReactable(ctx, message, fromId, fromLabel) {
  if (!config.enabled) return;

  // فقط برای پیام‌های چت/گروه (fromId موجود) محدودیت‌های کاربر را چک می‌کنیم
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
}

// پیام‌های عادی (چت خصوصی / گروه)
bot.on('message', async (ctx) => {
  try {
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

// پست‌های کانال (وقتی ربات ادمین کانال باشد)
bot.on('channel_post', async (ctx) => {
  try {
    if (!config.reactChannelPosts) return;
    // در پست‌های کانال معمولاً ctx.from وجود ندارد (پیام از طرف خود کانال است)
    await handleReactable(ctx, ctx.channelPost, null, `کانال:${ctx.chat?.title || ctx.chat?.id}`);
  } catch (error) {
    console.error('❌ خطا در پردازش پست کانال:', error.message);
  }
});

// ==================== دستورات عمومی ====================
bot.command('start', (ctx) => {
  ctx.reply(
    '🤖 سلام! من یک ربات ری‌اکشن خودکار هستم.\n' +
      'هر پیامی که در چت یا کانال ارسال بشه (اگه ادمین کانال باشم) یک ری‌اکشن دریافت می‌کنه!'
  );
});

bot.command('status', (ctx) => {
  const status = config.enabled ? '✅ فعال' : '❌ غیرفعال';
  ctx.reply(
    `وضعیت: ${status}\n` +
      `ری‌اکشن به پست‌های کانال: ${config.reactChannelPosts ? '✅' : '❌'}\n` +
      `Rate limit: ${config.rateLimit.maxPerWindow} ری‌اکشن هر ${config.rateLimit.windowMs / 1000} ثانیه\n` +
      `تعداد کاربران مستثنی: ${config.ignoreUsers.length}`
  );
});

// ==================== دستورات ادمین ====================
// توجه: اولین بار باید آی‌دی خودتان را دستی به adminIds در config.json اضافه کنید
// یا اگر لیست ادمین خالی باشد، به‌صورت پیش‌فرض همه اجازه دارند (برای راحتی تست).

function requireAdmin(ctx) {
  if (config.adminIds.length === 0) return true; // هنوز ادمینی تنظیم نشده -> باز است
  if (isAdmin(ctx.from.id)) return true;
  ctx.reply('⛔️ فقط ادمین می‌تواند این دستور را اجرا کند.');
  return false;
}

bot.command('toggle', (ctx) => {
  if (!requireAdmin(ctx)) return;
  config.enabled = !config.enabled;
  saveConfig(config);
  ctx.reply(`ربات ${config.enabled ? '✅ فعال' : '❌ غیرفعال'} شد.`);
});

bot.command('togglechannel', (ctx) => {
  if (!requireAdmin(ctx)) return;
  config.reactChannelPosts = !config.reactChannelPosts;
  saveConfig(config);
  ctx.reply(`ری‌اکشن به پست‌های کانال ${config.reactChannelPosts ? '✅ فعال' : '❌ غیرفعال'} شد.`);
});

// افزودن کاربر به لیست مستثنی: /ignore 123456789
bot.command('ignore', (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(/\s+/);
  const targetId = Number(parts[1]);
  if (!targetId) {
    return ctx.reply('استفاده صحیح: /ignore <user_id>');
  }
  if (!config.ignoreUsers.includes(targetId)) {
    config.ignoreUsers.push(targetId);
    saveConfig(config);
  }
  ctx.reply(`✅ کاربر ${targetId} به لیست مستثنی اضافه شد.`);
});

// حذف کاربر از لیست مستثنی: /unignore 123456789
bot.command('unignore', (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(/\s+/);
  const targetId = Number(parts[1]);
  if (!targetId) {
    return ctx.reply('استفاده صحیح: /unignore <user_id>');
  }
  config.ignoreUsers = config.ignoreUsers.filter((id) => id !== targetId);
  saveConfig(config);
  ctx.reply(`✅ کاربر ${targetId} از لیست مستثنی حذف شد.`);
});

// نمایش لیست کاربران مستثنی
bot.command('ignorelist', (ctx) => {
  if (!requireAdmin(ctx)) return;
  if (config.ignoreUsers.length === 0) {
    return ctx.reply('لیست کاربران مستثنی خالی است.');
  }
  ctx.reply('کاربران مستثنی:\n' + config.ignoreUsers.join('\n'));
});

// افزودن ادمین جدید: /addadmin 123456789
bot.command('addadmin', (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(/\s+/);
  const targetId = Number(parts[1]);
  if (!targetId) {
    return ctx.reply('استفاده صحیح: /addadmin <user_id>');
  }
  if (!config.adminIds.includes(targetId)) {
    config.adminIds.push(targetId);
    saveConfig(config);
  }
  ctx.reply(`✅ کاربر ${targetId} به لیست ادمین‌ها اضافه شد.`);
});

// تنظیم rate limit: /setratelimit <maxPerWindow> <windowSeconds>
bot.command('setratelimit', (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(/\s+/);
  const maxPerWindow = Number(parts[1]);
  const windowSeconds = Number(parts[2]);
  if (!maxPerWindow || !windowSeconds) {
    return ctx.reply('استفاده صحیح: /setratelimit <تعداد_مجاز> <بازه_به_ثانیه>');
  }
  config.rateLimit.maxPerWindow = maxPerWindow;
  config.rateLimit.windowMs = windowSeconds * 1000;
  saveConfig(config);
  ctx.reply(`✅ Rate limit تنظیم شد: ${maxPerWindow} ری‌اکشن هر ${windowSeconds} ثانیه.`);
});

// نمایش آی‌دی خودتان (برای اضافه کردن به adminIds در اولین راه‌اندازی)
bot.command('myid', (ctx) => {
  ctx.reply(`آی‌دی شما: ${ctx.from.id}`);
});

// ==================== راه‌اندازی و خاموشی امن ====================
bot.launch();
console.log('🤖 ربات شروع شد!');
console.log(`   حالت: ${config.enabled ? 'فعال' : 'غیرفعال'}`);
console.log(`   ری‌اکشن به کانال: ${config.reactChannelPosts ? 'فعال' : 'غیرفعال'}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
