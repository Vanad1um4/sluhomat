import fs from 'fs/promises';

class Logger {
  constructor(filename) {
    this.filename = filename;
  }

  async log(level, message, error = null) {
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] ${level}: ${message}`;

    if (error) {
      logEntry += `\nStack trace: ${error.stack}\n`;
    }

    try {
      await fs.appendFile(this.filename, logEntry + '\n');
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  async error(message, error = null) {
    await this.log('ERROR', message, error);
  }

  async warn(message, error = null) {
    await this.log('WARN', message, error);
  }

  async info(message) {
    await this.log('INFO', message);
  }
}

const logger = new Logger('bot_errors.log');
export default logger;
