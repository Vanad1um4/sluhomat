import logger from '../logger.js';
import { getConnection } from './db.js';

export async function dbGetUser(tgId) {
  const connection = await getConnection();
  try {
    await logger.info(`Getting user info for tgId: ${tgId}`);
    const query = `
      SELECT *
      FROM users
      WHERE tg_id = ?;
    `;
    const result = await connection.get(query, [tgId]);
    if (!result) {
      await logger.warn(`User not found: ${tgId}`);
    }
    return result;
  } catch (error) {
    await logger.error('Error getting user:', error);
    return null;
  } finally {
    await connection.close();
  }
}
