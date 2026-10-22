import { resolve } from 'node:path'
import { restoreDatabase } from './services/databaseBackups.cjs'

const [operation, databasePath, backupPath] = process.argv.slice(2)
if (operation !== 'restore' || !databasePath || !backupPath) {
  console.error('Usage: npm run restore -- <database.sqlite> <backup.sqlite> (stop BillMitra first)')
  process.exitCode = 1
} else {
  try {
    const restored = restoreDatabase(resolve(databasePath), resolve(backupPath))
    console.log('Database restored. Previous database retained at:', restored.previousDatabase ?? '(no previous file)')
  } catch (error) { console.error(error instanceof Error ? error.message : 'Restore failed.'); process.exitCode = 1 }
}
