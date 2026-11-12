// Re-exported from the shared db package so the API (watchdog) and worker use the same alert logic.
export { raiseAlert, resolveAlert, plog, notifyChange } from '@mailvault/db';
