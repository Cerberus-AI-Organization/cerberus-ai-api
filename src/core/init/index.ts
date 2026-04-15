import { pool } from '../database';
import { createSchema } from './schema';
import { runMigrations } from './migrations';
import { seedDefaults } from './seed';

export async function initDatabase(): Promise<void> {
  await createSchema(pool);
  await runMigrations(pool);

  try {
    await seedDefaults(pool);
  } catch (err) {
    console.warn('Warning: Could not seed default data:', err);
  }
}

export { initNodes } from './nodes';
export { initKnowledge, syncKnowledge } from './knowledge';
