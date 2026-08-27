export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupFile {
  schema_version: number;
  exported_at: string;
  settings: unknown;
  periods: unknown[];
  day_types: unknown[];
  entries: unknown[];
  holidays: unknown[];
}
