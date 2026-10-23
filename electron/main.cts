import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPosBackend } from './backend.cjs'
import { createRemotePos } from './remotePos.cjs'
import { posChannels } from '../shared/posChannels.js'
import { desktopPrinting } from './desktopPrinting.cjs'

let backend: ReturnType<typeof createPosBackend> | ReturnType<typeof createRemotePos>

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
    title: 'BillMitra',
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
    if (navigationUrl !== rendererEntry) event.preventDefault()
  })
  window.webContents.on('destroyed', () => {
    backend.logout(window.webContents.id)
  })

  if (!app.isPackaged) {
    void window.loadURL('http://127.0.0.1:5173')
  } else {
    void window.loadFile(join(__dirname, '../../dist/index.html'))
  }
}

app.whenReady().then(() => {
  if (!primaryInstance) return
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
