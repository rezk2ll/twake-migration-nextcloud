export const DOCTYPES = {
  MIGRATIONS: 'io.cozy.nextcloud.migrations',
  NC_FILES: 'io.cozy.remote.nextcloud.files',
  FILES: 'io.cozy.files',
  SETTINGS: 'io.cozy.settings',
} as const

export const MIGRATION_TOKEN_SCOPE = Object.values(DOCTYPES).join(' ')
