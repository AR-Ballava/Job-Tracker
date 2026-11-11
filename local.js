// Local run only (npm start / start.bat). Vercel ignores this file and uses src/index.js directly.
import express from 'express'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import { exec } from 'node:child_process';
import app from './src/index.js';
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Job Tracker running at http://localhost:' + PORT);
  if (process.env.OPEN_BROWSER !== 'false') exec(`${process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open'} http://localhost:${PORT}`);
});
