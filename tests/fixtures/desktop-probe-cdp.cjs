const { app, BrowserWindow } = require("electron");

app.setPath("userData", process.argv[2]);
app.commandLine.appendSwitch("remote-debugging-port", "0");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL("data:text/html,<title>Desktop probe acceptance</title>");
  process.stdout.write("desktop-probe-ready\n");
});
