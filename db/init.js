import { getConnection } from './db.js';
import { INIT_USERS } from '../env.js';
import logger from '../logger.js';

export async function dbInit() {
  const connection = await getConnection();

  const tables = [
    {
      name: 'users',
      query: `
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY,
          tg_id INTEGER UNIQUE,
          tg_username TEXT,
          tg_firstname TEXT,
          tg_lastname TEXT,
          is_admin BOOLEAN
        );
      `,
    },
  ];

  try {
    for (const table of tables) {
      await connection.exec(table.query);
      await logger.info(`Created/verified table: ${table.name}`);
    }

    const insertQuery = `
      INSERT OR IGNORE INTO users (tg_id, tg_username, tg_firstname, tg_lastname, is_admin)
      VALUES (?, ?, ?, ?, ?);
    `;

    for (const user of INIT_USERS) {
      await connection.run(insertQuery, [
        user.tgId,
        user.tgUsername ?? null,
        user.tgFirstname ?? null,
        user.tgLastname ?? null,
        user.isAdmin ? 1 : 0,
      ]);
      await logger.info(`Initialized user: ${user.tgUsername || user.tgId}`);
    }

    await logger.info('Database initialized successfully');
  } catch (error) {
    await logger.error('Database initialization error:', error);
    throw error;
  } finally {
    await connection.close();
  }
}
