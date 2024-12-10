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
  WARNING: '⚠️',
};

const RU_MESSAGES = {
  CONVERTING: 'Конвертация медиафайла',
  SPLITTING: 'Разделение аудио на части',
  TRANSCRIBING: 'Распознавание текста',
  REMAINING: 'Осталось приблизительно:',
  COMPLETED: 'Расшифровка завершена за',
  RESULTS: 'Результаты',
  ERROR: 'Произошла ошибка при обработке аудио.',
  PARTIAL_RESULTS: 'Частичные результаты распознавания',
  ERROR_WITH_PARTIAL: 'Произошла ошибка, но вот частичные результаты распознавания',
  ERROR_DETAILS: 'Детали ошибки',
};

async function cleanupTempFiles() {
  try {
    const tempDir = TEMP_FILES_DIR;
    const files = await fsPromises.readdir(tempDir);

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      await fsPromises.rm(filePath, { recursive: true, force: true });
    }
  } catch (error) {
    await logger.error('Error cleaning temp files:', error);
  }
}

function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('wav')
      .outputOptions('-vn')
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
    // For documents, audio and video files:
    return file.file_name.replace(/\.[^/.]+$/, ''); // Removing extension
  } else if (file.title) {
    // For audio messages with title:
    return file.title;
  } else {
    // For voice messages, video notes or when no name is available:
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '') // Removing hyphens and colons
      .replace(/\..+/, '') // Removing milliseconds
      .replace('T', '_'); // Replacing 'T' with underscore
    return `media_${timestamp}`;
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

async function updateTranscriptionProgress(
  steps,
  ctx,
  statusMsg,
  currentChunk,
  totalChunks,
  chunkProcessingTimes,
  hasError = false
) {
  let etaText = '';
  if (!hasError && chunkProcessingTimes.length > 0) {
    const avgProcessingTime = chunkProcessingTimes.reduce((a, b) => a + b, 0) / chunkProcessingTimes.length;
    const remainingChunks = totalChunks - currentChunk;
    const estimatedRemainingTime = (avgProcessingTime * remainingChunks) / 1000;
    etaText = `\n${RU_MESSAGES.REMAINING} ${formatTime(estimatedRemainingTime)}`;
  }

  const progressPercent = Math.round(((currentChunk + 1) / totalChunks) * 100);
  steps[2].text = `${RU_MESSAGES.TRANSCRIBING} (${progressPercent}%)`;
  if (!hasError && progressPercent < 100) {
    steps[2].text += etaText;
  }
  if (hasError) {
    steps[2].status = EMOJI.ERROR;
  }
  statusMsg = await updateStatusMessage(ctx, statusMsg, steps);
}

async function saveIntermediateResults(tempDir, file, transcription) {
  const baseFilename = getOriginalFilename(file);
  const transcriptionFilePath = path.join(tempDir, `${baseFilename}_partial.txt`);
  await fsPromises.writeFile(transcriptionFilePath, transcription, 'utf8');
  return transcriptionFilePath;
}

async function transcribeAudioChunks(chunks, steps, ctx, statusMsg) {
  let fullTranscription = '';
  const chunkProcessingTimes = [];
  let previousChunkText = '';
  let lastSavedPath = null;

  let i = 0;
  for (const chunk of chunks) {
    try {
      const chunkStartTime = Date.now();
      await updateTranscriptionProgress(steps, ctx, statusMsg, i, chunks.length, chunkProcessingTimes);
      const chunkText = await processAudioChunk(chunk, previousChunkText);
      const chunkProcessingTime = Date.now() - chunkStartTime;
      chunkProcessingTimes.push(chunkProcessingTime);
      fullTranscription += (i > 0 ? '\n' : '') + chunkText;
      previousChunkText = chunkText;

      if (i % 3 === 0 || i === chunks.length - 1) {
        lastSavedPath = await saveIntermediateResults(
          path.dirname(chunk.path),
          ctx.message.voice || ctx.message.audio || ctx.message.video || ctx.message.document,
          fullTranscription
        );
      }

      i++;
    } catch (error) {
      const progressPercent = Math.round(((i + 1) / chunks.length) * 100);

      await updateTranscriptionProgress(steps, ctx, statusMsg, i, chunks.length, chunkProcessingTimes, true);

      steps.push({
        text: `${EMOJI.WARNING} ${RU_MESSAGES.ERROR_WITH_PARTIAL} (${progressPercent}%): ${EMOJI.ARROW_DOWN}`,
        status: '',
      });
      await updateStatusMessage(ctx, statusMsg, steps);

      if (lastSavedPath) {
        await ctx.replyWithDocument({
          source: lastSavedPath,
        });
      }
      throw error;
    }
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

  const errorMessage = `${EMOJI.ERROR} ${RU_MESSAGES.ERROR}\n${
    error.message ? `${RU_MESSAGES.ERROR_DETAILS}: ${error.message}` : ''
  }`;
  if (statusMsg) {
    await ctx.telegram
      .editMessageText(statusMsg.chat.id, statusMsg.message_id, null, errorMessage)
      .catch(async (err) => await logger.error('Error sending error message:', err));
  } else {
    await ctx.reply(errorMessage).catch(async (err) => await logger.error('Error sending error message:', err));
  }
}

async function updateStatusMessage(ctx, statusMsg, steps) {
  const message = steps.map(({ text, status }) => `${status} ${text}`).join('\n');
  if (statusMsg) {
    return await ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, null, message);
  } else {
    return await ctx.reply(message);
  }
}

export async function handleAudioMessage(ctx) {
  await cleanupTempFiles();

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

    const file = ctx.message.voice || ctx.message.audio || ctx.message.video || ctx.message.document;
    if (!file) {
      throw new Error('No audio file found in message');
    }

    const steps = [];
    steps.push({ text: RU_MESSAGES.CONVERTING, status: EMOJI.PENDING });
    statusMsg = await updateStatusMessage(ctx, statusMsg, steps);

    tempDir = path.join(TEMP_FILES_DIR, file.file_id);
    await cleanDirectory(tempDir);

    const fileLink = await ctx.telegram.getFile(file.file_id);
    const downloadPath = path.join(tempDir, `original${path.extname(fileLink.file_path)}`);
    const wavPath = path.join(tempDir, 'converted.wav');

    await downloadAudioFile(ctx, file, downloadPath);
    await convertToWav(downloadPath, wavPath);

    steps[0].status = EMOJI.DONE;
    steps.push({ text: RU_MESSAGES.SPLITTING, status: EMOJI.PENDING });
    statusMsg = await updateStatusMessage(ctx, statusMsg, steps);

    const chunks = await splitAudioIntoChunks(wavPath, tempDir, CHUNK_LENGTH_MINUTES);

    steps[1].status = EMOJI.DONE;
    steps.push({ text: RU_MESSAGES.TRANSCRIBING, status: EMOJI.PENDING });
    statusMsg = await updateStatusMessage(ctx, statusMsg, steps);

    const fullTranscription = await transcribeAudioChunks(chunks, steps, ctx, statusMsg);

    steps[2].status = EMOJI.DONE;
    statusMsg = await updateStatusMessage(ctx, statusMsg, steps);

    await saveAndSendTranscription(ctx, tempDir, file, fullTranscription);

    const totalTime = formatTime((Date.now() - startTime) / 1000);
    steps.push({
      text: `${RU_MESSAGES.COMPLETED} ${totalTime}. ${RU_MESSAGES.RESULTS}: ${EMOJI.ARROW_DOWN}`,
      status: EMOJI.PARTY,
    });
    statusMsg = await updateStatusMessage(ctx, statusMsg, steps);

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
