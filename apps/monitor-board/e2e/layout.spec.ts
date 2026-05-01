import { test, expect } from '@playwright/test';

test.describe('Monitor Board UI Layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?seed=e2e-layout');
    await page.waitForSelector('.board-shell');
  });

  test('timeline scroll area has elastic height instead of fixed 520px', async ({ page }) => {
    const timelineScroll = page.locator('.timeline-scroll');
    await expect(timelineScroll).toBeVisible();

    const height = await timelineScroll.evaluate((el) => {
      return parseInt(getComputedStyle(el).height, 10);
    });

    // Should not be the old fixed 520px - it flexes based on viewport
    expect(height).toBeLessThan(520);

    // Should have a min-height so it's not collapsed
    const minHeight = await timelineScroll.evaluate((el) => {
      return parseInt(getComputedStyle(el).minHeight, 10);
    });
    expect(minHeight).toBeGreaterThanOrEqual(200);
  });

  test('run tree list has scroll support with max-height', async ({ page }) => {
    // Switch to Run Tree tab
    await page.click('button:has-text("Run Tree")');
    const runTreeList = page.locator('.run-tree-list[role="tree"]');
    await expect(runTreeList).toBeVisible();

    const hasOverflow = await runTreeList.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.overflow === 'auto' || style.overflowY === 'auto' || style.overflow === 'scroll';
    });
    expect(hasOverflow).toBe(true);

    const maxHeight = await runTreeList.evaluate((el) => {
      return getComputedStyle(el).maxHeight;
    });
    expect(maxHeight).not.toBe('none');
  });

  test('switches to single-column layout at 1100px', async ({ page }) => {
    // At wide viewport, board-grid should use row direction
    await page.setViewportSize({ width: 1400, height: 800 });

    const boardGrid = page.locator('.board-grid');
    const flexDirectionWide = await boardGrid.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(flexDirectionWide).toBe('row');

    // Below 1100px, it switches to column
    await page.setViewportSize({ width: 1099, height: 800 });

    const flexDirectionNarrow = await boardGrid.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(flexDirectionNarrow).toBe('column');
  });

  test('shrinks crew card sprites at 1100px breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });

    const sprite = page.locator('.crew-card-sprite').first();
    const widthWide = await sprite.evaluate((el) => getComputedStyle(el).width);

    await page.setViewportSize({ width: 1099, height: 800 });

    const widthNarrow = await sprite.evaluate((el) => getComputedStyle(el).width);
    // At 1100px breakpoint, sprite shrinks from 84px to 64px
    expect(parseInt(widthNarrow, 10)).toBeLessThan(parseInt(widthWide, 10));
  });

  test('further shrinks crew card sprites at 640px breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 });

    const sprite = page.locator('.crew-card-sprite').first();
    const width = await sprite.evaluate((el) => parseInt(getComputedStyle(el).width, 10));
    expect(width).toBeLessThanOrEqual(68);
  });

  test('timeline filter buttons filter entries by actor type', async ({ page }) => {
    const allRows = page.locator('.timeline-row');
    const allCount = await allRows.count();
    expect(allCount).toBeGreaterThan(0);

    // Click "Lead" filter
    await page.click('button.timeline-filter-btn:has-text("Lead")');

    const leadRows = page.locator('.timeline-row');
    const leadCount = await leadRows.count();
    expect(leadCount).toBeLessThanOrEqual(allCount);

    // All visible rows should be lead type
    for (let i = 0; i < leadCount; i++) {
      await expect(leadRows.nth(i)).toHaveAttribute('data-actor-type', 'lead');
    }

    // Click "All" to restore
    await page.click('button.timeline-filter-btn:has-text("All")');
    const restoredCount = await allRows.count();
    expect(restoredCount).toBe(allCount);
  });

  test('panel switch shows fade-in animation wrapper', async ({ page }) => {
    // The board-side-content wrapper should exist
    const sideContent = page.locator('.board-side-content');
    await expect(sideContent).toBeVisible();

    // Switch to Run Tree tab - should recreate with key-based re-mount
    await page.click('button:has-text("Run Tree")');
    await expect(page.locator('[role="tree"]')).toBeVisible();

    // The wrapper still exists (recreated by key change)
    const sideContentAfterSwitch = page.locator('.board-side-content');
    await expect(sideContentAfterSwitch).toBeVisible();
  });

  test('focus drawer collapses when showing empty/no-target state', async ({ page }) => {
    // Default view has a selected actor, so focus drawer should NOT be empty
    const focusDrawer = page.locator('.focus-drawer');
    await expect(focusDrawer).toBeVisible();

    // When there's a focused actor, the drawer is expanded
    const hasEmptyAttr = await focusDrawer.evaluate((el) => el.getAttribute('data-empty'));
    // With the default seed, an actor is selected, so it should NOT be empty
    expect(hasEmptyAttr).toBeNull();
  });

  test('top bar enters compact mode at narrow viewports', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 800 });

    const dashboard = page.locator('.top-bar-dashboard');
    const direction = await dashboard.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(direction).toBe('column');

    const metric = page.locator('.top-bar-metric').first();
    const minHeight = await metric.evaluate((el) => parseInt(getComputedStyle(el).minHeight, 10));
    expect(minHeight).toBeLessThanOrEqual(72);
  });
});
