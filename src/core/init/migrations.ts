import { Pool } from 'pg';

interface Migration {
  version: number;
  name: string;
  up: (pool: Pool) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'ip_port_to_url',
    up: async (pool) => {
      await pool.query(`
        ALTER TABLE compute_nodes ADD COLUMN IF NOT EXISTS url      TEXT;
        ALTER TABLE compute_nodes ADD COLUMN IF NOT EXISTS api_type TEXT NOT NULL DEFAULT 'ollama'
          CHECK (api_type IN ('ollama','openai'));
        ALTER TABLE compute_nodes ADD COLUMN IF NOT EXISTS api_key  TEXT;
      `);

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

      await pool.query(`
        ALTER TABLE compute_nodes DROP COLUMN IF EXISTS ip;
        ALTER TABLE compute_nodes DROP COLUMN IF EXISTS port;
      `);
    },
  },
];

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INT PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query<{ version: number }>('SELECT version FROM _migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    console.log(`Running migration ${migration.version}: ${migration.name}`);
    await migration.up(pool);
    await pool.query('INSERT INTO _migrations (version, name) VALUES ($1, $2)', [
      migration.version,
      migration.name,
    ]);
    console.log(`Migration ${migration.version} applied`);
  }
}
