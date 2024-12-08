import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import fs, { promises as fsPromises } from 'fs';
import OpenAI from 'openai';
import path from 'path';
import { pipeline } from 'stream/promises';

import { dbGetUser } from '../db/users.js';
import { CHUNK_LENGTH_MINUTES, MAX_PROMPT_LENGTH, OPENAI_API_KEY, TEMP_FILES_DIR, TG_BOT_KEY } from '../env.js';
import logger from '../logger.js';

ffmpeg.setFfmpegPath(ffmpegStatic);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const EMOJI = {
  DONE: '✅',
  PENDING: '⌛',
  ERROR: '❌',
  PARTY: '🎉',
  ARROW_DOWN: '⬇️',
};

const RU_MESSAGES = {
  CONVERTING: 'Конвертация аудио',
  SPLITTING: 'Разделение аудио на части',
  TRANSCRIBING: 'Распознавание текста',
  REMAINING: 'Осталось приблизительно:',
  COMPLETED: 'Расшифровка завершена за',
  RESULTS: 'Результаты',
  ERROR: 'Произошла ошибка при обработке аудио.',
};

async function cleanupOldTempFiles() {
  try {
    const tempDir = TEMP_FILES_DIR;
    const files = await fsPromises.readdir(tempDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stats = await fsPromises.stat(filePath);

      if (now - stats.mtimeMs > 3600000) {
        await fsPromises.rm(filePath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    await logger.error('Error cleaning old temp files:', error);
  }
}

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

function formatTime(seconds) {
  if (seconds < 60) {
    return `${Math.round(seconds)} сек`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes} мин ${remainingSeconds} сек`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours} ч ${minutes} мин`;
  }
}

function getOriginalFilename(file) {
  // Trying to get filename from different message types:
  if (file.file_name) {
    // For documents and audio files:
    return file.file_name.replace(/\.[^/.]+$/, ''); // Removing extension
  } else if (file.title) {
    // For audio messages with title:
    return file.title;
  } else {
    // For voice messages or when no name is available:
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '') // Removing hyphens and colons
      .replace(/\..+/, '') // Removing milliseconds
      .replace('T', '_'); // Replacing 'T' with underscore
    return `voice_${timestamp}`;
  }
}

async function splitAudioIntoChunks(inputPath, outputDir, chunkLengthMinutes) {
  const duration = await getAudioDuration(inputPath);
  const chunkLengthSeconds = chunkLengthMinutes * 60;
  const chunks = [];

  for (let start = 0; start < duration; start += chunkLengthSeconds) {
    const outputPath = path.join(outputDir, `chunk-${start}.wav`);
    const currentChunkLength = Math.min(chunkLengthSeconds, duration - start);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(start)
        .setDuration(currentChunkLength)
        .toFormat('wav')
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(outputPath);
    });

    chunks.push({
      path: outputPath,
      startTime: start,
      duration: currentChunkLength,
    });
  }

  return chunks;
}

async function cleanDirectory(directory) {
  try {
    await fsPromises.rm(directory, { recursive: true, force: true });
    await fsPromises.mkdir(directory, { recursive: true });
  } catch (error) {
    await logger.error('Error cleaning directory:', error);
    throw error;
  }
}

async function downloadAudioFile(ctx, file, downloadPath) {
  const fileLink = await ctx.telegram.getFile(file.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${TG_BOT_KEY}/${fileLink.file_path}`;

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  const fileStream = fs.createWriteStream(downloadPath);
  await pipeline(response.body, fileStream);

  return fileLink;
}

async function processAudioChunk(chunk, previousChunkText) {
  const prompt = previousChunkText.slice(-MAX_PROMPT_LENGTH);

  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(chunk.path),
    model: 'whisper-1',
    prompt: prompt,
    temperature: 0,
    language: 'ru',
  });

  return transcription.text.trim();
}

async function updateTranscriptionProgress(steps, updateStatus, currentChunk, totalChunks, chunkProcessingTimes) {
  let etaText = '';
  if (chunkProcessingTimes.length > 0) {
    const avgProcessingTime = chunkProcessingTimes.reduce((a, b) => a + b, 0) / chunkProcessingTimes.length;
    const remainingChunks = totalChunks - currentChunk;
    const estimatedRemainingTime = (avgProcessingTime * remainingChunks) / 1000;
    etaText = `\n${RU_MESSAGES.REMAINING} ${formatTime(estimatedRemainingTime)}`;
  }

  const progressPercent = Math.round(((currentChunk + 1) / totalChunks) * 100);
  steps[2].text = `Распознавание текста (${progressPercent}%)`;
  if (progressPercent < 100) {
    steps[2].text += etaText;
  }
  await updateStatus(steps);
}

async function transcribeAudioChunks(chunks, steps, updateStatus) {
  let fullTranscription = '';
  const chunkProcessingTimes = [];
  let previousChunkText = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunkStartTime = Date.now();

    await updateTranscriptionProgress(steps, updateStatus, i, chunks.length, chunkProcessingTimes);

    const chunkText = await processAudioChunk(chunks[i], previousChunkText);

    const chunkProcessingTime = Date.now() - chunkStartTime;
    chunkProcessingTimes.push(chunkProcessingTime);

    fullTranscription += (i > 0 ? '\n' : '') + chunkText;
    previousChunkText = chunkText;
  }

  return fullTranscription;
}

async function saveAndSendTranscription(ctx, tempDir, file, fullTranscription) {
  const baseFilename = getOriginalFilename(file);
  const transcriptionFilePath = path.join(tempDir, `${baseFilename}.txt`);
  await fsPromises.writeFile(transcriptionFilePath, fullTranscription, 'utf8');

  await ctx.replyWithDocument({
    source: transcriptionFilePath,
    filename: `${baseFilename}.txt`,
  });
}

async function handleErrorAndCleanup(error, ctx, statusMsg, file) {
  await logger.error('Error in handleAudioMessage:', error);
  const errorContext = {
    userId: ctx.message.from.id,
    messageId: ctx.message.message_id,
    chatId: ctx.chat.id,
    fileInfo: file ? JSON.stringify(file) : 'No file',
  };
  await logger.error(`Additional context: ${JSON.stringify(errorContext)}`);

  const errorMessage = `${EMOJI.ERROR} ${RU_MESSAGES.ERROR}`;
  if (statusMsg) {
    await ctx.telegram
      .editMessageText(statusMsg.chat.id, statusMsg.message_id, null, errorMessage)
      .catch(async (err) => await logger.error('Error sending error message:', err));
  } else {
    await ctx.reply(errorMessage).catch(async (err) => await logger.error('Error sending error message:', err));
  }
}

export async function handleAudioMessage(ctx) {
  await cleanupOldTempFiles();

  let tempDir = null;
  let statusMsg = null;
  const startTime = Date.now();

  try {
    const user = await dbGetUser(ctx.message.from.id);
    if (!user) {
      await logger.warn(`Unauthorized access attempt from user ${ctx.message.from.id}`);
      return;
    }

    await ctx.sendChatAction('typing');

    const file = ctx.message.voice || ctx.message.audio || ctx.message.document;
    if (!file) {
      throw new Error('No audio file found in message');
    }

    const updateStatus = async (steps) => {
      const message = steps.map(({ text, status }) => `${status} ${text}`).join('\n');
      if (statusMsg) {
        await ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, null, message);
      } else {
        statusMsg = await ctx.reply(message);
      }
    };

    const steps = [];
    steps.push({ text: RU_MESSAGES.CONVERTING, status: EMOJI.PENDING });
    await updateStatus(steps);

    tempDir = path.join(TEMP_FILES_DIR, file.file_id);
    await cleanDirectory(tempDir);

    const fileLink = await ctx.telegram.getFile(file.file_id);
    const downloadPath = path.join(tempDir, `original${path.extname(fileLink.file_path)}`);
    const wavPath = path.join(tempDir, 'converted.wav');

    await downloadAudioFile(ctx, file, downloadPath);
    await convertToWav(downloadPath, wavPath);

    steps[0].status = EMOJI.DONE;
    steps.push({ text: RU_MESSAGES.SPLITTING, status: EMOJI.PENDING });
    await updateStatus(steps);

    const chunks = await splitAudioIntoChunks(wavPath, tempDir, CHUNK_LENGTH_MINUTES);

    steps[1].status = EMOJI.DONE;
    steps.push({ text: RU_MESSAGES.TRANSCRIBING, status: EMOJI.PENDING });
    await updateStatus(steps);

    const fullTranscription = await transcribeAudioChunks(chunks, steps, updateStatus);

    steps[2].status = EMOJI.DONE;
    await updateStatus(steps);

    await saveAndSendTranscription(ctx, tempDir, file, fullTranscription);

    const totalTime = formatTime((Date.now() - startTime) / 1000);
    steps.push({
      text: `${RU_MESSAGES.COMPLETED} ${totalTime}. ${RU_MESSAGES.RESULTS}: ${EMOJI.ARROW_DOWN}`,
      status: EMOJI.PARTY,
    });
    await updateStatus(steps);

    await logger.info(`Successfully processed audio file ${file.file_id}`);
  } catch (error) {
    await handleErrorAndCleanup(error, ctx, statusMsg, file);
  } finally {
    if (tempDir) {
      try {
        const files = await fsPromises.readdir(tempDir);
        for (const file of files) {
          if (!file.endsWith('.txt')) {
            await fsPromises
              .unlink(path.join(tempDir, file))
              .catch(async (err) => await logger.error(`Error cleaning up file ${file}:`, err));
          }
        }
      } catch (error) {
        await logger.error('Error in cleanup:', error);
      }
    }
  }
}
