const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow () {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    autoHideMenuBar: true, // Скрывает верхнее меню File/Edit
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false // ВАЖНО: Это нужно, чтобы 3D-модели загружались с локального диска без ошибок CORS
    }
  });

  // Загружаем ваш главный файл
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});