import logger from '../logger.js';

export async function handleStart(ctx) {
  try {
    const message = [
      '👋 Привет! Я бот для расшифровки аудиозаписей.',
      'Отправь мне голосовое сообщение или аудиофайл, и я преобразую его в текст.',
      '',
      '⚠️ Важно: бот доступен только для авторизованных пользователей.',
    ];
    await ctx.reply(message.join('\n'));
    await logger.info(`Start command from user ${ctx.message.from.id}`);
  } catch (error) {
    await logger.error('Error handling start command:', error);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
}
