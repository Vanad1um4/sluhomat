import OpenAI from 'openai';
import { OPENAI_API_KEY, TG_BOT_KEY } from '../env.js';
import { dbGetUser } from '../db/users.js';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

export async function handleAudioMessage(ctx) {
  let downloadPath = null;
  let statusMsg = null;

  try {
    const user = await dbGetUser(ctx.message.from.id);
    if (!user) {
      await ctx.reply('Извините, но у вас нет доступа к этому боту. Обратитесь к администратору.');
      return;
    }

    await ctx.sendChatAction('typing');

    const file = ctx.message.voice || ctx.message.audio || ctx.message.document;
    if (!file) {
      throw new Error('No audio file found in message');
    }

    const fileId = file.file_id;
    const fileLink = await ctx.telegram.getFile(fileId);
    const filePath = fileLink.file_path;

    const fileName = `${fileId}.mp3`;
    downloadPath = path.join('temp', fileName);

    await fsPromises.mkdir('temp', { recursive: true });

    const fileUrl = `https://api.telegram.org/file/bot${TG_BOT_KEY}/${filePath}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    const fileStream = fs.createWriteStream(downloadPath);
    await pipeline(response.body, fileStream);

    statusMsg = await ctx.reply('⌛ Обрабатываю аудио...');

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(downloadPath),
      model: 'whisper-1',
    });

    await ctx.telegram.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      null,
      '✅ Расшифровка:\n\n' + transcription.text
    );
  } catch (error) {
    console.error('Error in handleAudioMessage:', error);

    const errorMessage = statusMsg
      ? ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, null, '❌ Произошла ошибка при обработке аудио.')
      : ctx.reply('❌ Произошла ошибка при обработке аудио.');

    await errorMessage.catch(console.error);
  } finally {
    if (downloadPath) {
      await fsPromises.unlink(downloadPath).catch((err) => console.error('Error deleting temporary file:', err));
    }
  }
}
