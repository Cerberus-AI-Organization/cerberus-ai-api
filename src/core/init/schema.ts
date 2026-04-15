import { Pool } from 'pg';

export async function createSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user'))
    );

    CREATE TABLE IF NOT EXISTS compute_nodes (
      id SERIAL PRIMARY KEY,
      hostname TEXT NOT NULL,
      url TEXT NOT NULL,
      priority INT NOT NULL DEFAULT 0,
      max_ctx INT NOT NULL DEFAULT 4096,
      max_layers_on_gpu INT NOT NULL DEFAULT -1,
      added_by INT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('online','offline')) DEFAULT 'offline',
      api_type TEXT NOT NULL CHECK (api_type IN ('ollama','openai')) DEFAULT 'ollama',
      api_key TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      title TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      last_modified TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chat_users (
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      sender_type VARCHAR(10) CHECK (sender_type IN ('user','ai')),
      sender_id INTEGER REFERENCES users(id),
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
