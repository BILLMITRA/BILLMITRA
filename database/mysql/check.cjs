const { loadMySqlSettings, connectMySql } = require('../../electron-dist/electron/mysqlConnection.cjs')

async function main() {
  const settings = loadMySqlSettings()
  if (!settings) throw new Error('The local BillMitra MySQL connection file is missing.')
  const pool = await connectMySql(settings)
  try {
    const [tables] = await pool.query(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()",
    )
    const [branches] = await pool.query('SELECT COUNT(*) AS count FROM branches')
    console.log('BillMitra MySQL connection: ready')
    console.log('Schema tables: ' + tables[0].count)
    console.log('Branches in MySQL: ' + branches[0].count)
  } finally { await pool.end() }
}

main().catch(() => {
  console.error('BillMitra MySQL connection failed. Check the service, schema and local configuration file.')
  process.exitCode = 1
})
