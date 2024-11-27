import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import logger from '../logger.js';

export const getConnection = async () => {
  try {
    const db = await open({
      filename: 'sluhomat.db',
      driver: sqlite3.Database,
    });
    await logger.info('Database connection established');
    return db;
  } catch (error) {
    await logger.error('Failed to establish database connection:', error);
    throw error;
  }
};
