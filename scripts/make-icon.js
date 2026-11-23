// Regenera build/icon.png y src/assets/icon.png desde un SVG (usa el Chromium de Playwright).
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#5865f2"/>
  <path d="M140 112h232a44 44 0 0 1 44 44v132a44 44 0 0 1-44 44H282l-74 62v-62h-68a44 44 0 0 1-44-44V156a44 44 0 0 1 44-44Z" fill="#fff"/>
  <path d="M196 188v112M316 188v112M196 244h120" stroke="#5865f2" stroke-width="30" stroke-linecap="round" fill="none"/>
</svg>`

;(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
  await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`)
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 512, height: 512 } })
  for (const out of ['build/icon.png', 'src/assets/icon.png']) {
    fs.mkdirSync(path.dirname(path.join(__dirname, '..', out)), { recursive: true })
    fs.writeFileSync(path.join(__dirname, '..', out), buf)
  }
  await browser.close()
  console.log('icono generado')
})()
