// Playwright for the screenshot script: not a dependency of the repository. Point PLAYWRIGHT at an installed `playwright` package.
const { join } = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright')
module.exports = { chromium, BASE: 'file://' + join(__dirname, '..', 'index.html'), SHOTS: join(__dirname, '..', 'shots') + '/' }
