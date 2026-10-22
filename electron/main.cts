import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPosBackend } from './backend.cjs'
import { posChannels } from '../shared/posChannels.js'

let backend: ReturnType<typeof createPosBackend>

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
    },
  })

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
  backend = createPosBackend(join(app.getPath('userData'), 'harbor-pos.sqlite'))
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
