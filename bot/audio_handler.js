import OpenAI from 'openai';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

import { OPENAI_API_KEY, TG_BOT_KEY, CHUNK_LENGTH_MINUTES } from '../env.js';
import { dbGetUser } from '../db/users.js';

ffmpeg.setFfmpegPath(ffmpegStatic);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('wav')
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

async function splitAudioIntoChunks(inputPath, outputDir, chunkLengthMinutes) {
  const duration = await getAudioDuration(inputPath);
  const chunkLengthSeconds = chunkLengthMinutes * 60;
  const chunks = [];

  for (let start = 0; start < duration; start += chunkLengthSeconds) {
    const outputPath = path.join(outputDir, `chunk-${start}.wav`);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(start)
        .setDuration(chunkLengthSeconds)
        .toFormat('wav')
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(outputPath);
    });

    chunks.push(outputPath);
  }

  return chunks;
}

export async function handleAudioMessage(ctx) {
  let downloadPath = null;
  let wavPath = null;
  let chunkPaths = [];
  let statusMsg = null;

  try {
    const user = await dbGetUser(ctx.message.from.id);
    if (!user) return;

    await ctx.sendChatAction('typing');

    const file = ctx.message.voice || ctx.message.audio || ctx.message.document;
    if (!file) {
      throw new Error('No audio file found in message');
    }

    const tempDir = path.join('temp', file.file_id);
    await fsPromises.mkdir(tempDir, { recursive: true });

    const fileId = file.file_id;
    const fileLink = await ctx.telegram.getFile(fileId);
    const filePath = fileLink.file_path;

    downloadPath = path.join(tempDir, `original${path.extname(filePath)}`);
    wavPath = path.join(tempDir, 'converted.wav');

    const fileUrl = `https://api.telegram.org/file/bot${TG_BOT_KEY}/${filePath}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    const fileStream = fs.createWriteStream(downloadPath);
    await pipeline(response.body, fileStream);

    statusMsg = await ctx.reply('⌛ Конвертирую аудио...');

    await convertToWav(downloadPath, wavPath);

    await ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, null, '⌛ Разбиваю на части...');

    chunkPaths = await splitAudioIntoChunks(wavPath, tempDir, CHUNK_LENGTH_MINUTES);

    let fullTranscription = '';

    for (let i = 0; i < chunkPaths.length; i++) {
      const progressPercent = Math.round(((i + 1) / chunkPaths.length) * 100);
      await ctx.telegram.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        null,
        `⌛ Обрабатываю часть ${i + 1} из ${chunkPaths.length} (${progressPercent}%), ждите...`
      );

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(chunkPaths[i]),
        model: 'whisper-1',
      });

      fullTranscription += (i > 0 ? '\n' : '') + transcription.text;
    }

    await ctx.telegram.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      null,
      '✅ Расшифровка:\n\n' + fullTranscription
    );
  } catch (error) {
    console.error('Error in handleAudioMessage:', error);

    const errorMessage = statusMsg
      ? ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, null, '❌ Произошла ошибка при обработке аудио.')
      : ctx.reply('❌ Произошла ошибка при обработке аудио.');

    await errorMessage.catch(console.error);
  } finally {
    if (downloadPath) {
      const tempDir = path.dirname(downloadPath);
      await fsPromises
        .rm(tempDir, { recursive: true, force: true })
        .catch((err) => console.error('Error deleting temporary directory:', err));
    }
  }
}
