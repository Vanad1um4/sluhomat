import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { TG_BOT_KEY } from './env.js';
import { dbInit } from './db/init.js';
import { handleStart } from './bot/commands.js';
import { handleAudioMessage } from './bot/audio_handler.js';
import { dbGetUser } from './db/users.js';

await dbInit();

const bot = new Telegraf(TG_BOT_KEY);

bot.command('start', handleStart);

bot.on(message('voice'), handleAudioMessage);
bot.on(message('audio'), handleAudioMessage);

bot.on(message('document'), async (ctx) => {
  const mime = ctx.message.document.mime_type;
  if (mime && mime.startsWith('audio/')) {
    await handleAudioMessage(ctx);
  }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
