import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

let pool = createPool();

function createPool() {
  const newPool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  newPool.on('error', (err) => {
    console.error('❌ Database connection error:', err);
    console.log('Reconnecting to database in 3s...');
    setTimeout(() => {
      pool = createPool();
    }, 3000);
  });

  return newPool;
}

export { pool };