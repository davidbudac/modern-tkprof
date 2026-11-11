// Playwright for the screenshot and check scripts: not a dependency of the repository. Point PLAYWRIGHT at an installed
// `playwright` package (e.g. an npx cache), or install it in a temporary directory outside the repository.
const { join } = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright')
module.exports = { chromium, URL: 'file://' + join(__dirname, '..', 'index.html'), SHOTS: join(__dirname, '..', 'shots') + '/' }
