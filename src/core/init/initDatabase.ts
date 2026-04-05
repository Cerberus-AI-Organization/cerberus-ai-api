import { pool } from '../database';
import bcrypt from 'bcrypt';

export async function initDatabase() {
    try {
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

        // ── Migration: ip + port → url ────────────────────────────────────────
        // Add new columns if they don't exist yet (safe to run on every startup)
        await pool.query(`
          ALTER TABLE compute_nodes ADD COLUMN IF NOT EXISTS url      TEXT;
          ALTER TABLE compute_nodes ADD COLUMN IF NOT EXISTS api_type TEXT NOT NULL DEFAULT 'ollama'
            CHECK (api_type IN ('ollama','openai'));
          ALTER TABLE compute_nodes ADD COLUMN IF NOT EXISTS api_key  TEXT;
        `);

        // Migrate existing rows: build url from legacy ip + port columns
        await pool.query(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'compute_nodes' AND column_name = 'ip'
            ) THEN
              UPDATE compute_nodes SET url = 'http://' || ip || ':' || port WHERE url IS NULL;
            END IF;
          END$$;
        `);

        // Make url NOT NULL now that all rows have a value
        await pool.query(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'compute_nodes' AND column_name = 'url'
                AND is_nullable = 'YES'
            ) THEN
              ALTER TABLE compute_nodes ALTER COLUMN url SET NOT NULL;
            END IF;
          END$$;
        `);

        // Drop legacy columns
        await pool.query(`
          ALTER TABLE compute_nodes DROP COLUMN IF EXISTS ip;
          ALTER TABLE compute_nodes DROP COLUMN IF EXISTS port;
        `);

        // ─────────────────────────────────────────────────────────────────────

        const result = await pool.query('SELECT COUNT(*) FROM users');
        const count = parseInt(result.rows[0].count, 10);

        if (count === 0) {
            console.log('No users found. Creating default admin user...');

            const hashedPassword = await bcrypt.hash('admin', 10);

            await pool.query(
                `INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)`,
                ['Administrator', 'admin@example.com', hashedPassword, 'admin']
            );

            console.log('❇️ Default admin created: email=admin@example.com, password=admin');
        } else {
            console.log('Users already exist, skipping admin creation.');
        }
    } catch (err) {
        console.error('Error initializing DB:', err);
    }
}
