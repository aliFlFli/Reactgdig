/**
 * helper-bots.js
 * ------------------------------------------------------------------
 * مدیریت ربات‌های کمکی که با توکن جدا وصل می‌شن و روی همون پیام‌هایی
 * که ربات اصلی ری‌اکشن می‌زنه، ری‌اکشن‌های اضافه (با ایموجی‌های متفاوت)
 * می‌زنن — برای تنوع بصری بیشتر روی کانال.
 *
 * نکات امنیتی/محدودیتی که رعایت شده:
 *  - هر ربات کمکی باید *خودش* در کانال ادمین باشه وگرنه ری‌اکشنش
 *    silently fail می‌شه (خطا لاگ می‌شه ولی کرش نمی‌کنه).
 *  - حداکثر تعداد ربات کمکی که هم‌زمان روی یک پیام ری‌اکشن می‌زنن
 *    محدود شده (MAX_CONCURRENT_HELPERS) تا رفتار مثل بمباران ری‌اکشن
 *    به نظر نرسه و ریسک بن شدن کم بشه.
 *  - بین ری‌اکشن هر ربات کمکی یک تاخیر تصادفی کوچک گذاشته شده.
 *  - توکن‌ها در فایل جدا (bots.json) نگه داشته می‌شن، نه در config.json
 *    عمومی، تا مدیریتش تمیزتر باشه.
 */

const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');

const BOTS_PATH = path.join(__dirname, 'bots.json');

// حداکثر تعداد ربات کمکی که روی یک پیام واحد اجازه دارن ری‌اکشن بزنن
const MAX_CONCURRENT_HELPERS = 3;
// بازه تاخیر تصادفی بین ری‌اکشن هر ربات کمکی (میلی‌ثانیه)
const MIN_DELAY_MS = 400;
const MAX_DELAY_MS = 2500;

function loadBotsFile() {
  try {
    if (fs.existsSync(BOTS_PATH)) {
      return JSON.parse(fs.readFileSync(BOTS_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('⚠️ خطا در خواندن bots.json:', err.message);
  }
  return { bots: [] }; // هر آیتم: { id, token, label, enabled }
}

function saveBotsFile(data) {
  try {
    fs.writeFileSync(BOTS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('⚠️ خطا در ذخیره bots.json:', err.message);
  }
}

/**
 * کلاس مدیریت‌کننده‌ی ربات‌های کمکی.
 * هر ربات کمکی یک نمونه‌ی Telegraf جدا داره که فقط برای فراخوانی
 * متدهای API (مثل setMessageReaction) استفاده می‌شه؛ launch/polling
 * روی این نمونه‌ها لازم نیست چون فقط قراره ری‌اکشن بزنن، نه پیام بخونن.
 */
class HelperBotManager {
  constructor() {
    this.data = loadBotsFile();
    this.instances = new Map(); // id -> { telegraf, meta }
    this._bootstrapInstances();
  }

  _bootstrapInstances() {
    for (const meta of this.data.bots) {
      this._createInstance(meta);
    }
  }

  _createInstance(meta) {
    try {
      const tg = new Telegraf(meta.token);
      this.instances.set(meta.id, { telegraf: tg, meta });
    } catch (err) {
      console.error(`⚠️ ساخت نمونه‌ی ربات کمکی ${meta.id} شکست خورد:`, err.message);
    }
  }

  list() {
    return this.data.bots;
  }

  /**
   * افزودن ربات کمکی جدید با توکن. برای اطمینان، ابتدا getMe صدا زده
   * می‌شه تا مطمئن بشیم توکن معتبره و اطلاعات ربات (username) گرفته بشه.
   */
  async addBot(token) {
    const trimmed = token.trim();
    if (!trimmed || trimmed.includes(' ')) {
      throw new Error('توکن نامعتبر است.');
    }
    if (this.data.bots.some((b) => b.token === trimmed)) {
      throw new Error('این توکن قبلاً اضافه شده است.');
    }

    const tg = new Telegraf(trimmed);
    let me;
    try {
      me = await tg.telegram.getMe();
    } catch (err) {
      throw new Error('توکن معتبر نیست یا ربات در دسترس نیست: ' + err.message);
    }

    const id = me.id;
    if (this.data.bots.some((b) => b.id === id)) {
      throw new Error('رباتی با همین آی‌دی قبلاً اضافه شده است.');
    }

    const meta = {
      id,
      token: trimmed,
      label: me.username ? `@${me.username}` : `bot_${id}`,
      enabled: true,
      addedAt: new Date().toISOString(),
    };

    this.data.bots.push(meta);
    saveBotsFile(this.data);
    this.instances.set(id, { telegraf: tg, meta });

    return meta;
  }

  removeBot(id) {
    const numId = Number(id);
    const before = this.data.bots.length;
    this.data.bots = this.data.bots.filter((b) => b.id !== numId);
    saveBotsFile(this.data);
    this.instances.delete(numId);
    return this.data.bots.length < before;
  }

  toggleBot(id) {
    const numId = Number(id);
    const meta = this.data.bots.find((b) => b.id === numId);
    if (!meta) return null;
    meta.enabled = !meta.enabled;
    saveBotsFile(this.data);
    return meta;
  }

  enabledBots() {
    return this.data.bots.filter((b) => b.enabled);
  }

  /**
   * تلاش برای ری‌اکشن با یک ربات کمکی خاص روی یک پیام مشخص.
   * از متد خام تلگرام (setMessageReaction) استفاده می‌کنیم چون Telegraf
   * ctx.react فقط برای ربات صاحب همان کانتکست معنی داره.
   */
  async _reactWithBot(meta, chatId, messageId, emoji) {
    const inst = this.instances.get(meta.id);
    if (!inst) return false;
    try {
      await inst.telegraf.telegram.callApi('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
        is_big: false,
      });
      return true;
    } catch (err) {
      const desc = err?.response?.description || err.message || '';
      console.error(`❌ ربات کمکی ${meta.label} نتوانست ری‌اکشن بزند:`, desc);
      return false;
    }
  }

  /**
   * چند ربات کمکی فعال (حداکثر MAX_CONCURRENT_HELPERS تا) رو با تاخیر
   * تصادفی روی یک پیام ری‌اکشن می‌زنه. emojiPool لیست ایموجی‌های
   * ممکنه؛ هر ربات یکی رو تصادفی انتخاب می‌کنه.
   */
  async reactOnMessage(chatId, messageId, emojiPool) {
    const active = this.enabledBots();
    if (active.length === 0) return;

    // انتخاب تصادفی زیرمجموعه‌ای از ربات‌ها تا سقف مجاز
    const shuffled = [...active].sort(() => Math.random() - 0.5);
    const chosen = shuffled.slice(0, MAX_CONCURRENT_HELPERS);

    for (const meta of chosen) {
      const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
      // بدون await روی کل حلقه تا موازی و با تاخیرهای مستقل اجرا بشن
      setTimeout(() => {
        const emoji = emojiPool[Math.floor(Math.random() * emojiPool.length)];
        this._reactWithBot(meta, chatId, messageId, emoji);
      }, delay);
    }
  }
}

module.exports = { HelperBotManager, MAX_CONCURRENT_HELPERS };
