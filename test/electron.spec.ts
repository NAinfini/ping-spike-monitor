import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('frontend shell keeps navigation, chart, dialogs, and locales inside their layout bounds', async ({}, testInfo) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'ping-spike-monitor-e2e-'))
  const electronApp = await electron.launch({
    args: [resolve('out/main/index.js'), `--user-data-dir=${join(dataDirectory, 'profile')}`],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PING_SPIKE_DATA_DIR: dataDirectory
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await expect(page.getByRole('heading', { name: 'Follow the signal, not a score.' })).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 900 })

    const titlebar = page.locator('.window-titlebar')
    const minimizeButton = page.getByRole('button', { name: 'Minimize' })
    const maximizeButton = page.locator('.window-control-maximize')
    await expect(titlebar).toBeVisible()
    await expect(minimizeButton).toBeVisible()
    const logoState = await page.locator('.window-titlebar-logo, .brand-mark img').evaluateAll((images) =>
      images.map((image) => ({ complete: (image as HTMLImageElement).complete, width: (image as HTMLImageElement).naturalWidth }))
    )
    expect(logoState).toHaveLength(2)
    expect(logoState.every((image) => image.complete && image.width > 0)).toBe(true)

    await minimizeButton.click()
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false
    )).toBe(true)
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.restore()
      window?.show()
    })
    await expect(minimizeButton).toBeVisible()

    await maximizeButton.click()
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false
    )).toBe(true)
    await expect(maximizeButton).toHaveAttribute('aria-label', 'Restore')
    await maximizeButton.click()
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false
    )).toBe(false)
    await expect(maximizeButton).toHaveAttribute('aria-label', 'Maximize')

    const rail = page.locator('.side-rail')
    const overviewButton = page.getByRole('button', { exact: true, name: 'Overview' })
    const titlebarBox = await titlebar.boundingBox()
    const initialRailBox = await rail.boundingBox()
    const initialOverviewBox = await overviewButton.boundingBox()
    expect(initialRailBox?.y).toBe(titlebarBox?.height)
    expect(initialRailBox?.height).toBe(900 - (titlebarBox?.height ?? 0))
    expect(initialOverviewBox?.height).toBeLessThanOrEqual(50)

    await expect(page.locator('.latency-chart')).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: testInfo.outputPath('electron-desktop-top.png') })

    await page.getByRole('button', { name: 'Data table' }).click()
    await expect(page.getByRole('heading', { name: 'Recent latency samples' })).toBeVisible()
    await page.getByRole('button', { name: 'Close data table' }).click()
    await page.getByRole('button', { name: 'Choose a custom time range' }).click()
    await expect(page.getByRole('heading', { name: 'Custom time range' })).toBeVisible()
    await page.getByLabel('From', { exact: true }).fill('2000-01-01T00:00')
    await page.getByLabel('To', { exact: true }).fill('2000-01-01T01:00')
    await page.getByRole('button', { name: 'Apply range' }).click()
    expect(await page.locator('.latency-chart').count()).toBe(0)
    await expect(page.getByText('Actual coverage: No retained samples')).toBeVisible()
    await page.getByRole('button', { name: 'Return live' }).click()
    await expect(page.locator('.latency-chart')).toBeVisible({ timeout: 15_000 })

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect(page.getByText('Ping Spike', { exact: false }).first()).toBeVisible()
    const scrolledRailBox = await rail.boundingBox()
    expect(scrolledRailBox?.y).toBe(titlebarBox?.height)

    const desktopGeometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }))
    expect(desktopGeometry.scrollWidth).toBeLessThanOrEqual(desktopGeometry.clientWidth)
    await page.screenshot({ path: testInfo.outputPath('electron-desktop-scrolled.png') })

    await page.getByRole('button', { exact: true, name: 'Incidents' }).click()
    await expect(page.getByRole('heading', { name: 'Incidents, not raw noise.' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    await page.getByRole('button', { exact: true, name: 'Regions' }).click()
    await expect(page.getByRole('heading', { name: 'Regional routes need corroboration.' })).toBeVisible()
    await page.getByRole('button', { exact: true, name: 'Speed tests' }).click()
    await expect(page.getByRole('heading', { name: 'Speed testing is a diagnostic load.' })).toBeVisible()
    await page.getByRole('button', { exact: true, name: 'Targets & settings' }).click()
    await expect(page.getByRole('heading', { name: 'Targets define the evidence.' })).toBeVisible()
    await overviewButton.click()
    await expect(page.getByRole('heading', { name: 'Follow the signal, not a score.' })).toBeVisible()

    await page.setViewportSize({ width: 720, height: 700 })
    await page.evaluate(() => window.scrollTo(0, 0))
    const compactGeometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll<HTMLElement>('body *')]
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return { className: element.className, right: Math.round(rect.right), tag: element.tagName }
        })
        .filter((item) => item.right > document.documentElement.clientWidth + 1)
        .slice(0, 10)
    }))
    expect(compactGeometry.scrollWidth, JSON.stringify(compactGeometry.offenders)).toBeLessThanOrEqual(compactGeometry.clientWidth)
    const compactNavigation = page.getByRole('navigation', { name: 'Monitor views' })
    await expect(compactNavigation).toBeVisible()
    const compactNavigationGeometry = await compactNavigation.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      items: [...element.children].map((item) => {
        const rect = item.getBoundingClientRect()
        return { left: Math.round(rect.left), right: Math.round(rect.right) }
      })
    }))
    expect(compactNavigationGeometry.scrollWidth, JSON.stringify(compactNavigationGeometry)).toBeLessThanOrEqual(compactNavigationGeometry.clientWidth)
    const compactNavWidths = await page.locator('.nav-item').evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().width)
    )
    expect(Math.max(...compactNavWidths)).toBeLessThan(170)
    const pathGeometry = await page.locator('.health-path').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }))
    expect(pathGeometry.scrollWidth).toBeLessThanOrEqual(pathGeometry.clientWidth)
    await page.screenshot({ path: testInfo.outputPath('electron-compact.png') })

    const html = page.locator('html')
    const initialTheme = await html.getAttribute('data-theme')
    await page.locator('.theme-button').click()
    const alternateTheme = initialTheme === 'dark' ? 'light' : 'dark'
    await expect(html).toHaveAttribute('data-theme', alternateTheme)
    await expect.poll(() => page.locator('.range-trigger').first().evaluate((element) =>
      getComputedStyle(element).backgroundColor
    )).toBe(alternateTheme === 'dark' ? 'rgb(21, 27, 34)' : 'rgb(255, 255, 255)')
    await page.screenshot({ path: testInfo.outputPath('electron-compact-alternate-theme.png') })
    await page.locator('.theme-button').click()

    await page.getByRole('combobox', { name: 'Display language' }).click()
    await page.getByRole('option', { name: '简体中文' }).click()
    await expect(page.getByRole('heading', { name: '追踪信号，而非分数。' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await page.reload()
    await expect(page.getByRole('heading', { name: '追踪信号，而非分数。' })).toBeVisible()
    await page.getByRole('combobox', { name: '显示语言' }).click()
    await page.getByRole('option', { name: 'Français' }).click()
    await expect(page.getByRole('heading', { name: 'Suivez le signal, pas un score.' })).toBeVisible()
    const frenchGeometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }))
    expect(frenchGeometry.scrollWidth).toBeLessThanOrEqual(frenchGeometry.clientWidth)
    const frenchNavigationGeometry = await page.getByRole('navigation', { name: 'Vues du moniteur' }).evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }))
    expect(frenchNavigationGeometry.scrollWidth).toBeLessThanOrEqual(frenchNavigationGeometry.clientWidth)
    await page.screenshot({ path: testInfo.outputPath('electron-french-compact.png') })

    await page.locator('.window-control-close').click()
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isVisible() ?? true
    )).toBe(false)
  } finally {
    await electronApp.close()
    rmSync(dataDirectory, { force: true, recursive: true })
  }
})
