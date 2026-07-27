const { Telegraf, Markup } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// تنظیمات
const config = {
  enabled: true,
  delayMs: 0, // تاخیر قبل از ری‌اکشن
  maxReactions: 1, // حداکثر تعداد ری‌اکشن
  ignoreUsers: [], // کاربران مستثنی
};

const reactions = {
  greeting: ['👋', '😊', '🙌', '👋'],
  happy: ['😂', '🎉', '❤️', '🔥'],
  support: ['👍', '💪', '🔥', '✅'],
  question: ['🤔', '❓', '💡', '🔍'],
  love: ['❤️', '💕', '😍', '💖'],
  thanks: ['🙏', '❤️', '👍', '😊'],
};

function detectMessageType(text) {
  if (!text) return 'support';
  
  const lowerText = text.toLowerCase();
  
  if (/سلام|درود|خوب|بی‌تاب|سلامت/.test(lowerText)) return 'greeting';
  if (/خنده|خوشحال|شاد|عالی|فوق‌العاده/.test(lowerText)) return 'happy';
  if (/کمک|لطفا|لطف|اگر/.test(lowerText)) return 'support';
  if (/\?|چطور|چی|کدوم|کجا|چرا/.test(lowerText)) return 'question';
  if (/دوست|عشق|محبت|دل|آن/.test(lowerText)) return 'love';
  if (/ممنون|تشکر|مرسی|سپاس/.test(lowerText)) return 'thanks';
  
  return 'support';
}

// ری‌اکشن هوشمند
bot.on('message', async (ctx) => {
  try {
    // بررسی فعال بودن ربات
    if (!config.enabled) return;
    
    // بررسی کاربران مستثنی
    if (config.ignoreUsers.includes(ctx.from.id)) return;
    
    const messageText = ctx.message.text || ctx.message.caption || '';
    const messageType = detectMessageType(messageText);
    
    // بررسی تاخیر
    if (config.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, config.delayMs));
    }
    
    // انتخاب emoji
    const availableEmojis = reactions[messageType] || reactions.support;
    const emoji = availableEmojis[Math.floor(Math.random() * availableEmojis.length)];
    
    // اضافه کردن ری‌اکشن
    await ctx.react(emoji);
    
    console.log(`✅ کاربر: ${ctx.from.first_name} | ری‌اکشن: ${emoji}`);
  } catch (error) {
    console.error('❌ خطا:', error.message);
  }
});

// دستورات
bot.command('start', (ctx) => {
  ctx.reply('🤖 سلام! من یک ربات ری‌اکشن خودکار هستم.\nهر پیامی که بفرستید یک ری‌اکشن دریافت می‌کند!');
});

bot.command('status', (ctx) => {
  const status = config.enabled ? '✅ فعال' : '❌ غیرفعال';
  ctx.reply(`وضعیت: ${status}`);
});

bot.command('toggle', (ctx) => {
  config.enabled = !config.enabled;
  ctx.reply(`ربات ${config.enabled ? '✅ فعال' : '❌ غیرفعال'} شد.`);
});

// شروع ربات
bot.launch();
console.log('🤖 ربات شروع شد!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
        
