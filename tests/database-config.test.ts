import { describe, expect, it } from 'vitest';
import { databaseUrl } from '../packages/db/src/config.js';

describe('database configuration', () => {
  it('round-trips reserved characters in credentials and database names', () => {
    const env = {
      POSTGRES_USER: 'demo@user',
      POSTGRES_PASSWORD: 'p@ss:$#/?% word',
      POSTGRES_DB: 'demo/db',
      DB_HOST: 'db',
      DB_PORT: '5432',
    };
    const url = new URL(databaseUrl(env));
    expect(decodeURIComponent(url.username)).toBe(env.POSTGRES_USER);
    expect(decodeURIComponent(url.password)).toBe(env.POSTGRES_PASSWORD);
    expect(decodeURIComponent(url.pathname.slice(1))).toBe(env.POSTGRES_DB);
    expect(url.hostname).toBe('db');
    expect(url.port).toBe('5432');
  });
  it('supports an explicit external URL but falls back for an empty Compose override', () => {
    expect(databaseUrl({ DATABASE_URL: 'postgresql://external/db' })).toBe('postgresql://external/db');
    expect(new URL(databaseUrl({ DATABASE_URL: '', POSTGRES_PASSWORD: 'local' })).port).toBe('55432');
  });
  it('fails clearly without a password instead of using a hardcoded credential', () => {
    expect(() => databaseUrl({})).toThrow('POSTGRES_PASSWORD');
  });
});
