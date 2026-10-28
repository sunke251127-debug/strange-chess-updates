'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '../renderer/icon.svg'), 'utf8');
  const browser = await chromium.launch(process.env.CODEX_ROUTER_BROWSER ? { executablePath: process.env.CODEX_ROUTER_BROWSER } : { channel: 'msedge' });
  try {
    for (const size of [192, 512]) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent('<style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>' + svg);
      await page.screenshot({ path: path.join(__dirname, '../renderer/icon-' + size + '.png') });
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
