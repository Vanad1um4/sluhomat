import { getConnection } from './db.js';
import { INIT_USERS } from '../env.js';

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
    }

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  } finally {
    await connection.close();
  }
}
