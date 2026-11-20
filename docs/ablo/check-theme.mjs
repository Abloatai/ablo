import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['light', 'dark']) {
      await page.goto(process.argv[2] ?? 'http://localhost:3213');
      if (await page.locator('html').getAttribute('data-theme') !== mode) {
        await page.getByRole('button', { name: 'Toggle color theme', exact: true }).click();
      }
      await page.reload();
      assert.equal(await page.locator('html').getAttribute('data-theme'), mode);
      const colors = await page.evaluate(() => {
        const ctx = document.createElement('canvas').getContext('2d');
        return ['backgroundColor', 'color'].map(property => {
          ctx.fillStyle = getComputedStyle(document.body)[property];
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        });
      });
      for (const color of colors) assert.ok(Math.max(...color) - Math.min(...color) <= 1, 'Neutral page colors');
      const [background, foreground] = colors.map(color => color[0]);
      assert.ok(mode === 'light' ? background > 245 && foreground < 40 : background < 40 && foreground > 245);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const chrome = await page.evaluate(() => {
        const style = selector => getComputedStyle(document.querySelector(selector));
        return {
          headingFont: style('h1').fontFamily,
          bodyFont: style('body').fontFamily,
          headerHeight: style('[data-blume-header]').height,
          header: style('[data-blume-header]').backgroundColor,
          sidebar: style('[data-blume-nav-drawer]').backgroundColor,
          body: style('body').backgroundColor,
          radius: style('[data-blume-search-open]').borderRadius,
          visibleIcons: [...document.querySelectorAll('[data-blume-nav-drawer] svg.shrink-0')]
            .filter(icon => getComputedStyle(icon).display !== 'none').length,
        };
      });
      assert.equal(chrome.headingFont, chrome.bodyFont, 'Headings use the application font');
      assert.ok(!chrome.headingFont.toLowerCase().includes('grotesk'));
      assert.equal(chrome.headerHeight, '64px');
      assert.equal(chrome.header, chrome.sidebar, 'Header and sidebar share the application surface');
      assert.notEqual(chrome.header, chrome.body);
      assert.equal(chrome.radius, '4px', 'Controls retain the tighter corners');
      assert.equal(chrome.visibleIcons, 0, 'Navigation has no decorative icons');

      if (width === 390) {
        await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
        await page.waitForFunction(() => Math.abs(document.querySelector('[data-blume-nav-drawer]').getBoundingClientRect().left) < 1);
      }
      await page.locator('[data-blume-nav-drawer]').getByRole('link', { name: 'Installation', exact: true }).click();
      await page.getByRole('heading', { name: 'Installation', exact: true, level: 1 }).waitFor();
      await page.waitForLoadState();
      assert.equal(await page.locator('.prose pre.astro-code').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(38, 37, 34)');
      await page.getByRole('button', { name: /Search/ }).first().click();
      const input = page.getByPlaceholder('Search documentation…');
      await input.fill('claims');
      await page.locator('[data-blume-search-dialog] a').first().waitFor();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.locator('[data-blume-search-dialog]').waitFor({ state: 'hidden' });
      await page.goto(new URL('/api-reference/', process.argv[2] ?? 'http://localhost:3213').href);
      if (width === 390) {
        await page.getByRole('button', {name:'Toggle navigation', exact:true}).click();
        await page.waitForFunction(() => Math.abs(document.querySelector('[data-blume-nav-drawer]').getBoundingClientRect().left)<1);
      }
      const apiSidebar = page.locator('[data-blume-nav-drawer]');
      assert.equal(await apiSidebar.locator('details').count(), 0, 'API groups remain open like Lobby section headings');
      assert.equal(await apiSidebar.getByText(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/).count(), 0, 'API sidebar has no method badges');
      for (const group of ['Models', 'Claims', 'Credentials', 'Branches', 'Schema', 'Logs', 'Commits']) {
        assert.equal(await apiSidebar.getByText(group, {exact:true}).count(), 1, `API group ${group} appears once`);
      }
      await apiSidebar.getByRole('link', {name:/Create a row/}).click();
      await page.getByRole('heading', {name:'Create a row', exact:true, level:1}).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth), true);
      console.log(`${width}px ${mode}: neutral colors, theme, search, flat API navigation and no overflow`);
    }
  }
} finally {
  await browser.close();
}
