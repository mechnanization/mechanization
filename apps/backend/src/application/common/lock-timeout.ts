import { APP_CONFIG } from './app.config';

/** What `setLocalLockTimeout` needs: a transaction client, or any client inside a transaction. */
interface RawExecutor {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/**
 * `SET LOCAL lock_timeout` for the rest of the caller's transaction, at
 * `APP_CONFIG.locks.rowLockTimeout`: a write that meets a row another write
 * holds is refused after that long rather than queueing behind it.
 *
 * `set_config(…, true)` is `SET LOCAL` with the value bound, so no string is
 * built into the SQL. Outside a transaction it would last only the statement,
 * so call it first thing inside one.
 */
export async function setLocalLockTimeout(db: RawExecutor): Promise<void> {
  await db.$executeRaw`SELECT set_config('lock_timeout', ${APP_CONFIG.locks.rowLockTimeout}, true)`;
}
