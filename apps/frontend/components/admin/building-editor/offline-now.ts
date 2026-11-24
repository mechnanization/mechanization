/** Whether the browser says it has no connection (the save then goes to the queue). */
export function offlineNow(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
