import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPosBackend } from './backend.cjs'
import { createRemotePos } from './remotePos.cjs'
import { posChannels } from '../shared/posChannels.js'
import { desktopPrinting } from './desktopPrinting.cjs'

let backend: ReturnType<typeof createPosBackend> | ReturnType<typeof createRemotePos>
const branchControlMode = process.argv.includes('--branch-control') || basename(process.execPath).toLowerCase().startsWith('billmitra manager')

// Electron's single-instance lock lives under userData. Give the manager program
// its own lock so it can run beside the cashier without redirecting its window.
if (branchControlMode) app.setPath('userData', join(app.getPath('appData'), 'BillMitra Manager'))

async function ensureBranchServer(): Promise<void> {
  const origin = 'http://127.0.0.1:3017'
  process.env.BILLMITRA_DESKTOP_SERVER = origin
  process.env.BILLMITRA_DESKTOP_BRANCH ??= 'main'
  const healthy = async () => {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2500) })
      return response.ok
    } catch { return false }
  }
  if (await healthy()) return

  const homeFile = join(app.getPath('userData'), 'server-home.txt')
  const candidate = process.env.BILLMITRA_SERVER_HOME
    ?? (existsSync(homeFile) ? readFileSync(homeFile, 'utf8').trim() : '')
    ?? ''
  const home = candidate || join(app.getPath('desktop'), 'billling sofware')
  const entry = join(home, 'web-data', 'mobile-test', 'start-server.cjs')
  if (!existsSync(entry) || !existsSync(join(home, '.env.mysql.local'))) {
    throw new Error('The local branch server files were not found. Start BillMitra Manager from the branch installation folder.')
  }
  writeFileSync(homeFile, home, 'utf8')
  const child = spawn(process.execPath, [entry], {
    cwd: home,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await healthy()) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('The local branch server did not start. Check MySQL and the branch server configuration.')
}

// A shared printer journal must have a single desktop owner.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows().find(item => item.isVisible())
  if (window) { if (window.isMinimized()) window.restore(); window.focus() }
})

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#f5f6f8',
    title: branchControlMode ? 'BillMitra Manager' : 'BillMitra',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  const printers = desktopPrinting(window, app.getPath('userData'), `${process.env.BILLMITRA_DESKTOP_SERVER ?? 'local'}|${process.env.BILLMITRA_DESKTOP_BRANCH ?? 'main'}`, (channel, id, input) => backend.invoke(channel, id, input))
  for (const [channel, action] of Object.entries({ 'desktop-print:state': () => printers.getState(), 'desktop-print:settings': (input: unknown) => printers.saveSettings(input), 'desktop-print:details': (input: unknown) => printers.getOrderDetails(input), 'desktop-print:request': (input: unknown) => printers.request(input) })) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Desktop printer access is restricted to the application window.')
      return action(input)
    })
  }

  const rendererEntry = app.isPackaged
    ? pathToFileURL(join(__dirname, '../../dist/index.html')).href
    : 'http://127.0.0.1:5173/'
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== rendererEntry && navigationUrl !== `${rendererEntry}?mode=branch-control`) event.preventDefault()
  })
  window.webContents.on('destroyed', () => {
    backend.logout(window.webContents.id)
  })

  if (!app.isPackaged) {
    void window.loadURL(`http://127.0.0.1:5173/${branchControlMode ? '?mode=branch-control' : ''}`)
  } else {
    void window.loadFile(join(__dirname, '../../dist/index.html'), branchControlMode ? { query: { mode: 'branch-control' } } : undefined)
  }
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  if (branchControlMode) {
    try { await ensureBranchServer() }
    catch (error) {
      const { dialog } = await import('electron')
      dialog.showErrorBox('BillMitra Manager server', error instanceof Error ? error.message : 'Unable to start the local server.')
      app.quit()
      return
    }
  }
  const connectedOrigin = process.env.BILLMITRA_DESKTOP_SERVER
  backend = connectedOrigin
    ? createRemotePos(connectedOrigin, process.env.BILLMITRA_DESKTOP_BRANCH ?? 'main')
    : createPosBackend(join(app.getPath('userData'), 'harbor-pos.sqlite'))
  for (const channel of Object.values(posChannels)) {
    ipcMain.handle(channel, (event, input: unknown) => {
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error('This operation is available only to the application window.')
      }
      return backend.invoke(channel, event.sender.id, input)
    })
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => { backend?.close() })
