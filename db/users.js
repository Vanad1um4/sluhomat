import { getConnection } from './db.js';

export async function dbGetUser(tgId) {
  const connection = await getConnection();
  try {
    const query = `
      SELECT *
      FROM users
      WHERE tg_id = ?;
    `;
    const result = await connection.get(query, [tgId]);
    return result;
  } catch (error) {
    console.error('Error getting user:', error);
    return null;
  } finally {
    await connection.close();
  }
}
