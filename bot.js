import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';

import { handleAudioMessage } from './bot/audio_handler.js';
import { handleStart } from './bot/commands.js';
import { dbInit } from './db/init.js';
import { TG_BOT_KEY } from './env.js';
import logger from './logger.js';

process.on('uncaughtException', async (error) => {
  await logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', async (error) => {
  await logger.error('Unhandled Rejection:', error);
});

await dbInit();

const bot = new Telegraf(TG_BOT_KEY);

bot.catch(async (err, ctx) => {
  await logger.error(`Error while handling update ${ctx.update.update_id}:`, err);
  const adminMessage = `Error in chat ${ctx.chat?.id}: ${err.message}`;
  await logger.error(adminMessage);
});

bot.command('start', handleStart);

bot.on(message('voice'), handleAudioMessage);
bot.on(message('audio'), handleAudioMessage);
bot.on(message('video'), handleAudioMessage);
bot.on(message('video_note'), handleAudioMessage);

bot.on(message('document'), async (ctx) => {
  const mime = ctx.message.document.mime_type;
  const supportedVideoTypes = [
    'video/mp4',
    'video/quicktime', // MOV
    'video/x-msvideo', // AVI
    'video/x-matroska', // MKV
    'video/webm',
    'video/x-flv',
    'video/x-ms-wmv',
    'video/3gpp',
  ];

  if (mime && (mime.startsWith('audio/') || mime.startsWith('video/') || supportedVideoTypes.includes(mime))) {
    await handleAudioMessage(ctx);
  }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
