import { Pool } from 'pg';
import bcrypt from 'bcrypt';

export async function seedDefaults(pool: Pool): Promise<void> {
  const result = await pool.query('SELECT COUNT(*) FROM users');
  const count = parseInt(result.rows[0].count, 10);

  if (count > 0) return;

  console.log('No users found. Creating default admin user...');
  const hashedPassword = await bcrypt.hash('admin', 10);
  await pool.query(
    'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)',
    ['Administrator', 'admin@example.com', hashedPassword, 'admin']
  );
  console.log('Default admin created: email=admin@example.com, password=admin');
}
