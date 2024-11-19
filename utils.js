import fs from 'fs/promises';
import { STRANGER_LOGS_FILENAME } from './const.js';

export function escapeHTML(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function logMessageToFile(message) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    from: message.from,
    chat: message.chat,
    text: message.text,
  };

  const logString = JSON.stringify(logEntry, null, 2);

  try {
    await fs.appendFile(`${STRANGER_LOGS_FILENAME}`, logString + '\n\n');
  } catch (error) {
    console.error('Error logging message to file:', error);
  }
}
