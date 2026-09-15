/** Shared by host processes and Compose; encode credentials rather than interpolate raw secrets. */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (!env.POSTGRES_PASSWORD) throw new Error('Set POSTGRES_PASSWORD in .env or provide DATABASE_URL');
  const url = new URL('postgresql://127.0.0.1:55432/relay');
  url.hostname = env.DB_HOST || '127.0.0.1';
  url.port = env.DB_PORT || '55432';
  url.username = encodeURIComponent(env.POSTGRES_USER || 'relay');
  url.password = encodeURIComponent(env.POSTGRES_PASSWORD);
  url.pathname = `/${encodeURIComponent(env.POSTGRES_DB || 'relay')}`;
  return url.href;
}
