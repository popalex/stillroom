import { test, expect, type BrowserContext, type Page } from '@playwright/test';

async function authenticator(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  await session.send('WebAuthn.enable');
  return {
    session,
    ...(await session.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })),
  };
}
const passphrase = 'copper orchard sailboat winter river';
test('browser upload, encrypted storage, second-device viewing, and recovery', async ({
  browser,
  page,
  context,
}) => {
  // One long journey through the app, including 300 uploads and animations that
  // Playwright waits out before each click.
  test.setTimeout(120_000);
  await authenticator(context, page);
  const uploadedBodies: Buffer[] = [];
  const external: string[] = [];
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (event) => {
    if (event.type() === 'error') browserErrors.push(event.text());
  });
  page.on('request', (req) => {
    if (req.url().startsWith('http') && !req.url().startsWith('http://localhost:4173'))
      external.push(req.url());
    if (req.method() === 'PUT' && req.url().includes('/api/objects/'))
      uploadedBodies.push(req.postDataBuffer()!);
  });
  await page.goto('/');
  await page.getByLabel('Device name', { exact: true }).fill('Upload PC');
  await page.getByLabel('Enrollment code', { exact: true }).fill('e'.repeat(64));
  await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create your image vault' })).toBeVisible();
  await page.getByLabel('Vault passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Create encrypted vault' }).click();
  const recovery = await page.locator('.recovery-secret').innerText();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Open the empty collection' }).click();
  await expect(page.getByRole('heading', { name: 'Your collection starts here' })).toBeVisible();
  await page.getByRole('button', { name: 'Add category', exact: true }).click();
  await page.getByLabel('Category name').fill('Private walks');
  await page.getByRole('dialog').getByRole('button', { name: 'Add category', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Upload images', exact: true })).toBeEnabled();
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#d9e4e6';
      ctx.fillRect(0, 0, 800, 600);
      ctx.fillStyle = '#59878a';
      ctx.fillRect(100, 100, 600, 400);
      ctx.fillStyle = '#c3d6ad';
      ctx.beginPath();
      ctx.arc(400, 300, 130, 0, Math.PI * 2);
      ctx.fill();
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  await page
    .getByLabel('Upload image files')
    .setInputFiles({ name: 'private-garden.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('button', { name: 'View private-garden.png' })).toBeVisible({
    timeout: 30_000,
  });
  expect(uploadedBodies).toHaveLength(3);
  for (const body of uploadedBodies) expect(body.includes(png)).toBe(false);
  const state = await page.evaluate(async () => (await fetch('/api/vault')).text());
  expect(state).not.toContain('Private walks');
  expect(state).not.toContain('private-garden');
  expect(state).not.toContain(passphrase);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  expect(
    await page.evaluate(async () => ({
      databases: (await indexedDB.databases()).length,
      caches: (await caches.keys()).length,
    })),
  ).toEqual({ databases: 0, caches: 0 });
  await page.getByRole('button', { name: 'View private-garden.png' }).click();
  await expect(page.getByRole('dialog').locator('.viewer-image img')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Manage devices' }).click();
  await page.getByLabel("New device's Tailscale IP").fill('127.0.0.1');
  await page.getByRole('button', { name: 'Create enrollment code' }).click();
  const invitation = await page.locator('.invite-result output').innerText();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({
    path: 'test-results/gallery-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const viewer = await phone.newPage();
  await authenticator(phone, viewer);
  await viewer.goto('/');
  await viewer.getByRole('button', { name: 'Set up a new device' }).click();
  await viewer.getByLabel('Device name', { exact: true }).fill('My phone');
  await viewer.getByLabel('Enrollment code', { exact: true }).fill(invitation);
  await viewer.getByRole('button', { name: 'Create passkey', exact: true }).click();
  await viewer.getByLabel('Vault passphrase', { exact: true }).fill(passphrase);
  await viewer.getByRole('button', { name: 'Unlock collection' }).click();
  await expect(viewer.getByRole('button', { name: 'View private-garden.png' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Upload images', exact: true })).toHaveCount(0);
  await viewer.getByRole('button', { name: /^Private walks/ }).click();
  await expect(viewer.getByRole('button', { name: /^More actions for/ })).toHaveCount(0);
  await viewer.getByRole('combobox', { name: 'Sort by', exact: true }).selectOption('name-desc');
  await expect(viewer.getByRole('combobox', { name: 'Sort by', exact: true })).toBeEnabled();
  expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await viewer.screenshot({
    path: 'test-results/gallery-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await viewer.getByRole('button', { name: 'View private-garden.png' }).click();
  await expect(viewer.getByRole('dialog').locator('img')).toBeVisible();
  const download = viewer.waitForEvent('download');
  await viewer.getByRole('button', { name: 'Download original' }).click();
  const file = await download;
  const stream = await file.createReadStream();
  const parts: Buffer[] = [];
  for await (const part of stream!) parts.push(part);
  expect(Buffer.concat(parts)).toEqual(png);
  await viewer.getByRole('button', { name: 'Close', exact: true }).click();
  await viewer.getByRole('button', { name: 'Lock collection', exact: true }).click();
  await expect(viewer.getByRole('heading', { name: 'Open your collection' })).toBeVisible();
  await expect(viewer.locator('.image-card')).toHaveCount(0);
  await phone.close();

  await page.getByRole('button', { name: 'Lock collection', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await page.getByRole('button', { name: 'Use a recovery secret' }).click();
  await page.getByLabel('Recovery secret', { exact: true }).fill(recovery);
  await page
    .getByLabel('New vault passphrase', { exact: true })
    .fill('a new passphrase for recovery testing');
  await page
    .getByLabel('Confirm passphrase', { exact: true })
    .fill('a new passphrase for recovery testing');
  await page.getByRole('button', { name: 'Recover and unlock' }).click();
  await expect(page.getByRole('button', { name: 'View private-garden.png' })).toBeVisible();
  for (const viewport of [
    { width: 1280, height: 600 },
    { width: 390, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'View private-garden.png' }).click();
    await page.getByRole('button', { name: 'Edit details', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Save details' })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('button', { name: 'Permanently delete' })).toBeInViewport({
      ratio: 1,
    });
    await dialog
      .getByRole('combobox', { name: 'Category', exact: true })
      .selectOption(viewport.width > 720 ? '' : 'Private walks');
    await page.screenshot({ path: `test-results/image-details-${viewport.width}.png` });
    await dialog.getByRole('button', { name: 'Save details' }).click();
    await expect(dialog.locator('.edit-details')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await page.getByRole('button', { name: 'View private-garden.png' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm permanent deletion' })).toBeInViewport({
    ratio: 1,
  });
  await page.getByRole('button', { name: 'Cancel deletion' }).click();
  await expect(page.getByRole('button', { name: 'Permanently delete', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Permanently delete', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm permanent deletion' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View private-garden.png' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await page
    .getByLabel('Vault passphrase', { exact: true })
    .fill('a new passphrase for recovery testing');
  await page.getByRole('button', { name: 'Unlock collection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload images', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View private-garden.png' })).toHaveCount(0);
  const sort = page.getByRole('combobox', { name: 'Sort by', exact: true });
  await expect(sort).toHaveValue('date-desc');
  await page.getByLabel('Upload image files').setInputFiles(
    ['photo2.png', 'alpha.png', 'photo10.png'].map((name) => ({
      name,
      mimeType: 'image/png',
      buffer: png,
    })),
  );
  await expect(page.getByRole('button', { name: 'Upload images', exact: true })).toBeEnabled();
  const names = page.locator('.image-card .image-name');
  // Phones keep the search field behind a round button until it is opened.
  const searchField = page.locator('.search-field input');
  const searchFor = async (text: string) => {
    if (!(await searchField.isVisible()))
      await page.getByRole('button', { name: 'Open search', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search photographs' }).fill(text);
  };
  // Rename and Delete category live in the ⋯ menu of an open category.
  const categoryMenu = page.getByRole('button', { name: /^More actions for/ });
  const categoryAction = async (name: string) => {
    await categoryMenu.click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  await expect(names).toHaveText(['photo10.png', 'alpha.png', 'photo2.png']);
  const catalogBeforeSorting = await page.evaluate(async () => (await fetch('/api/vault')).json());
  for (const [order, expected] of [
    ['date-asc', ['photo2.png', 'alpha.png', 'photo10.png']],
    ['name-desc', ['photo10.png', 'photo2.png', 'alpha.png']],
    ['name-asc', ['alpha.png', 'photo2.png', 'photo10.png']],
  ] as const) {
    await sort.selectOption(order);
    await expect(sort).toBeEnabled();
    await expect(names).toHaveText([...expected]);
  }
  expect(await page.evaluate(async () => (await fetch('/api/vault')).json())).toEqual(
    catalogBeforeSorting,
  );
  // Every GET for an object from here on is a viewing preview, once the grid's
  // thumbnails are in.
  await expect(page.locator('.image-card img')).toHaveCount(3);
  let event = 0;
  const previewLoads = new Map<string, { started: number; finished?: number }>();
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().includes('/api/objects/'))
      previewLoads.set(req.url(), { started: event++ });
  });
  page.on('requestfinished', (req) => {
    const load = previewLoads.get(req.url());
    if (load) load.finished = event++;
  });
  await page.getByRole('button', { name: 'View alpha.png' }).click();
  await expect(page.getByRole('dialog').locator('.viewer-image img')).toBeVisible();
  // alpha.png and both of its neighbours, the open image first.
  await expect.poll(() => [...previewLoads.values()].filter((l) => l.finished).length).toBe(3);
  const [first, ...rest] = [...previewLoads.values()];
  for (const load of rest) expect(load.started).toBeGreaterThan(first.finished!);
  await page.getByRole('button', { name: 'Next image' }).click();
  // Already decoded, so the image is there in the same render as the click.
  expect(await page.locator('.viewer-image [role="status"]').count()).toBe(0);
  await expect(page.getByRole('dialog')).toHaveAccessibleName('photo2.png');
  await expect(page.getByRole('dialog').locator('.viewer-image img')).toBeVisible();
  expect(previewLoads.size).toBe(3);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // Closing the viewer drops the decrypted previews, so opening it again fetches.
  previewLoads.clear();
  await page.getByRole('button', { name: 'View alpha.png' }).click();
  await expect.poll(() => previewLoads.size).toBe(3);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await searchFor('photo');
  await expect(names).toHaveText(['photo2.png', 'photo10.png']);
  await searchFor('');
  await page.getByRole('button', { name: /^Private walks/ }).click();
  await expect(names).toHaveCount(0);
  // Select needs something to select in the current view, not just the collection.
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0);
  // Uncategorized has no icon, but its count still looks like the others.
  const countStyle = (label: RegExp) =>
    page
      .getByRole('button', { name: label })
      .locator('.nav-count')
      .evaluate((count) => {
        const style = getComputedStyle(count);
        return [style.color, style.fontSize, style.fontFamily].join(' ');
      });
  expect(await countStyle(/^Uncategorized/)).toBe(await countStyle(/^All photographs/));
  await page.getByRole('button', { name: /^All photographs/ }).click();
  await expect(names).toHaveText(['alpha.png', 'photo2.png', 'photo10.png']);
  // The logo goes back to the whole collection from a category and a search.
  await page.getByRole('button', { name: /^Private walks/ }).click();
  await searchFor('alpha');
  await page.getByRole('button', { name: 'stillroom, show all photographs' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All photographs');
  await expect(searchField).toHaveValue('');
  await expect(names).toHaveText(['alpha.png', 'photo2.png', 'photo10.png']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results/sorting-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.reload();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await page
    .getByLabel('Vault passphrase', { exact: true })
    .fill('a new passphrase for recovery testing');
  await page.getByRole('button', { name: 'Unlock collection', exact: true }).click();
  await expect(sort).toHaveValue('name-asc');
  await expect(names).toHaveText(['alpha.png', 'photo2.png', 'photo10.png']);
  await expect(categoryMenu).toHaveCount(0);
  await page.getByRole('button', { name: /^Private walks/ }).click();
  await categoryAction('Delete category');
  await expect(page.getByRole('dialog')).toContainText('all 0 images');
  await page.getByRole('button', { name: 'Permanently delete category', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Private walks/ })).toHaveCount(0);
  await expect(names).toHaveText(['alpha.png', 'photo2.png', 'photo10.png']);

  // Select mode moves several images in one catalog write. A shift-click picks a
  // range in grid order and a second click on a picked image drops it.
  let catalogWrites = 0;
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().endsWith('/api/catalog')) catalogWrites++;
  });
  const bar = page.getByRole('form', { name: 'Move selected images' });
  const pickImage = (name: string) =>
    page.getByRole('button', { name: `Select ${name}`, exact: true });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await pickImage('alpha.png').click();
  await pickImage('photo10.png').click({ modifiers: ['Shift'] });
  await expect(bar.getByRole('status')).toHaveText('3 selected');
  await pickImage('photo2.png').click();
  await expect(bar.getByRole('status')).toHaveText('2 selected');
  await expect(pickImage('photo2.png')).toHaveAttribute('aria-pressed', 'false');
  await expect(pickImage('photo10.png')).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('button', { name: 'New category', exact: true }).click();
  await bar.getByLabel('New category name', { exact: true }).fill(' Trips ');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/bulk-move-mobile.png', animations: 'disabled' });
  await bar.getByRole('button', { name: 'Move', exact: true }).click();
  // A move ends select mode and says where the images went.
  const notice = page.locator('.gallery-notice');
  await expect(notice).toHaveText('Moved 2 images to Trips.');
  await page.screenshot({
    path: 'test-results/bulk-move-notice-mobile.png',
    animations: 'disabled',
  });
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View alpha.png', exact: true })).toBeVisible();
  expect(catalogWrites).toBe(1);
  await expect(page.getByRole('button', { name: /^Trips/ })).toContainText('2');
  await expect(page.locator('.image-card .image-category')).toHaveText([
    'Trips',
    'Uncategorized',
    'Trips',
  ]);
  // Renaming a category moves its images with it and keeps it open. A reserved
  // name fails, and a change of capitalisation alone is allowed.
  await page.getByRole('button', { name: /^Trips/ }).click();
  await categoryAction('Rename');
  const rename = page.getByRole('dialog', { name: 'Rename category' });
  const newName = rename.getByLabel('New name for "Trips"');
  await expect(newName).toHaveValue('Trips');
  await newName.fill('All');
  await rename.getByRole('button', { name: 'Rename category', exact: true }).click();
  await expect(rename.getByRole('alert')).toContainText('Choose a different category name');
  await newName.fill(' Holidays ');
  await page.screenshot({
    path: 'test-results/rename-category-mobile.png',
    animations: 'disabled',
  });
  await rename.getByRole('button', { name: 'Rename category', exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Holidays');
  await expect(page.getByRole('button', { name: /^Holidays/ })).toContainText('2');
  await expect(page.getByRole('button', { name: /^Trips/ })).toHaveCount(0);
  await expect(page.locator('.image-card .image-category')).toHaveText(['Holidays', 'Holidays']);
  await categoryAction('Rename');
  await rename.getByLabel('New name for "Holidays"').fill('trips');
  await rename.getByRole('button', { name: 'Rename category', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('trips');
  await categoryAction('Rename');
  await rename.getByLabel('New name for "trips"').fill('Trips');
  await rename.getByRole('button', { name: 'Rename category', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trips');
  expect(catalogWrites).toBe(4);
  // Esc leaves select mode. Then select all in the Trips view and move back to
  // an existing category.
  await expect(names).toHaveText(['alpha.png', 'photo10.png']);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(bar.getByRole('status')).toHaveText('2 selected');
  await bar.getByRole('combobox', { name: 'Move to', exact: true }).selectOption('');
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.screenshot({ path: 'test-results/bulk-move-desktop.png', animations: 'disabled' });
  await bar.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(notice).toHaveText('Moved 2 images to Uncategorized.');
  await expect(bar).toHaveCount(0);
  expect(catalogWrites).toBe(5);
  await expect(names).toHaveCount(0);
  await expect(notice).toHaveCount(0, { timeout: 6000 });
  await categoryAction('Delete category');
  await page.getByRole('button', { name: 'Permanently delete category', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Trips/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^All photographs/ }).click();
  await expect(page.getByRole('button', { name: 'View alpha.png', exact: true })).toBeVisible();

  for (const [filename, width] of [
    ['alpha.png', 1280],
    ['photo2.png', 390],
  ] as const) {
    await page.setViewportSize({ width, height: 640 });
    await page.getByRole('button', { name: `View ${filename}`, exact: true }).click();
    await page.getByRole('button', { name: 'Edit details', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'New category', exact: true }).click();
    await dialog.getByLabel('New category name', { exact: true }).fill(' Uncategorized ');
    await dialog.getByRole('button', { name: 'Save details', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Choose a different category name');
    if (filename === 'alpha.png') {
      await dialog.getByLabel('New category name', { exact: true }).fill('  To delete  ');
    } else {
      await dialog.getByLabel('New category name', { exact: true }).fill('To delete');
      await dialog.getByRole('button', { name: 'Save details', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('That category already exists');
      await dialog.getByRole('button', { name: 'Use existing category', exact: true }).click();
      await dialog
        .getByRole('combobox', { name: 'Category', exact: true })
        .selectOption('To delete');
    }
    await dialog.getByRole('button', { name: 'Save details', exact: true }).click();
    await expect(dialog.locator('.edit-details')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: /^To delete/ })).toHaveCount(1);
  }
  await page.getByRole('button', { name: /^To delete/ }).click();
  await expect(names).toHaveText(['alpha.png', 'photo2.png']);
  await searchFor('alpha');
  await expect(names).toHaveText(['alpha.png']);
  await expect(categoryMenu).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results/category-actions-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  // The menu's delete is red text with no fill; only the dialog's confirm is solid red.
  const background = (role: 'button' | 'menuitem', name: string) =>
    page
      .getByRole(role, { name, exact: true })
      .evaluate((button) => getComputedStyle(button).backgroundColor);
  await categoryMenu.click();
  expect(await background('menuitem', 'Delete category')).toBe('rgba(0, 0, 0, 0)');
  await page.getByRole('menuitem', { name: 'Delete category', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('"To delete" and all 2 images');
  expect(await background('button', 'Permanently delete category')).toBe('rgb(179, 38, 30)');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(names).toHaveText(['alpha.png']);
  await categoryAction('Delete category');
  const deletionRequest = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith('/api/catalog'),
  );
  await page.getByRole('button', { name: 'Permanently delete category', exact: true }).click();
  expect((await deletionRequest).postDataJSON().deleteObjects).toHaveLength(6);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^To delete/ })).toHaveCount(0);
  await expect(searchField).toHaveValue('');
  await expect(names).toHaveText(['photo10.png']);
  // Bulk delete counts picks that the search hides, and Cancel keeps them.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await pickImage('photo10.png').click();
  await searchFor('nothing matches');
  await expect(names).toHaveCount(0);
  await expect(bar.getByRole('status')).toHaveText('1 selected');
  await bar.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 1 image' });
  await expect(confirm).toContainText('1 of them is hidden by the current category or search');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(bar.getByRole('status')).toHaveText('1 selected');
  await bar.getByRole('button', { name: 'Delete', exact: true }).click();
  const bulkDeletion = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith('/api/catalog'),
  );
  await confirm.getByRole('button', { name: 'Permanently delete 1 image', exact: true }).click();
  expect((await bulkDeletion).postDataJSON().deleteObjects).toHaveLength(3);
  await expect(notice).toHaveText('Deleted 1 image.');
  await expect(bar).toHaveCount(0);
  await searchFor('');
  await expect(names).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await page
    .getByLabel('Vault passphrase', { exact: true })
    .fill('a new passphrase for recovery testing');
  await page.getByRole('button', { name: 'Unlock collection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your collection starts here' })).toBeVisible();
  await expect(names).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^To delete|^Private walks/ })).toHaveCount(0);

  // A large collection renders only the rows near the screen. At every scroll
  // position each rendered card must sit in its own row, the cards must cover
  // the screen, and the padding must keep the grid as tall as all its rows.
  const many = 300;
  const tiles = await page.evaluate((count) => {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      // Every fifth tile is portrait, which the grid must letterbox, not crop.
      const canvas = document.createElement('canvas');
      canvas.width = i % 5 === 1 ? 120 : 160;
      canvas.height = i % 5 === 1 ? 200 : 120;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = `hsl(${(i * 37) % 360} 40% 60%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      out.push(canvas.toDataURL('image/png').split(',')[1]);
    }
    return out;
  }, many);
  await page.getByLabel('Upload image files').setInputFiles(
    tiles.map((data, i) => ({
      name: `tile-${String(i).padStart(3, '0')}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(data, 'base64'),
    })),
  );
  await expect(page.locator('.collection-count')).toHaveText(`${many}`, { timeout: 120_000 });
  await expect(page.locator('.upload-progress')).toHaveCount(0);
  await sort.selectOption('name-asc');
  const layout = () =>
    page.evaluate((count) => {
      const grid = document.querySelector<HTMLElement>('.image-grid')!;
      const cards = [...grid.querySelectorAll<HTMLElement>('.image-card')];
      const style = getComputedStyle(grid);
      const columns = style.gridTemplateColumns.split(' ').length;
      const box = grid.getBoundingClientRect();
      const stride = cards[0].getBoundingClientRect().height + parseFloat(style.rowGap);
      const misplaced = cards.filter((card) => {
        const index = Number(card.querySelector('.image-name')!.textContent!.slice(5, 8));
        const top = box.top + Math.floor(index / columns) * stride;
        return Math.abs(card.getBoundingClientRect().top - top) > 1;
      });
      const contentBottom = box.bottom - parseFloat(style.paddingBottom);
      const thumbnails = cards.flatMap((card) => {
        const img = card.querySelector('img');
        return img?.complete && img.naturalWidth ? [{ img, well: img.parentElement! }] : [];
      });
      return {
        rendered: cards.length,
        columns,
        misplaced: misplaced.length,
        thumbnails: thumbnails.length,
        cropped: thumbnails.filter(
          ({ img, well }) =>
            img.getBoundingClientRect().height > well.getBoundingClientRect().height + 1,
        ).length,
        covered:
          cards[0].getBoundingClientRect().top <= Math.max(0, box.top) + 1 &&
          cards.at(-1)!.getBoundingClientRect().bottom >= Math.min(innerHeight, contentBottom) - 1,
        fullHeight:
          Math.abs(box.height - (Math.ceil(count / columns) * stride - parseFloat(style.rowGap))) <=
          1,
      };
    }, many);
  const steadyAt = async (at: number) => {
    await page.evaluate(
      (at) => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * at),
      at,
    );
    await expect.poll(layout).toMatchObject({ misplaced: 0, covered: true, fullHeight: true });
    await expect.poll(async () => (await layout()).thumbnails).toBeGreaterThan(4);
    expect((await layout()).cropped).toBe(0);
    expect((await layout()).rendered).toBeLessThan(many / 2);
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => scrollTo(0, 0));
    for (const at of [0, 0.3, 0.6, 1, 0.1]) await steadyAt(at);
  }
  // The thumbnail size changes the columns and the row height, and the window
  // follows. Each device's size is saved on the server.
  const columns = async () => (await layout()).columns;
  const savedSize = () =>
    page.evaluate(async () => (await (await fetch('/api/preferences')).json()).gridSize);
  await page.setViewportSize({ width: 1280, height: 800 });
  const sizes = page.getByRole('group', { name: 'Thumbnail size' });
  await expect(sizes.getByRole('button', { name: 'Medium thumbnails' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const medium = await columns();
  await sizes.getByRole('button', { name: 'Small thumbnails' }).click();
  await expect.poll(columns).toBeGreaterThan(medium);
  await expect.poll(savedSize).toBe('small');
  for (const at of [0.5, 1]) await steadyAt(at);
  await sizes.getByRole('button', { name: 'Large thumbnails' }).click();
  await expect.poll(columns).toBeLessThan(medium);
  for (const at of [0.5, 0]) await steadyAt(at);
  await page.screenshot({ path: 'test-results/large-desktop.png', animations: 'disabled' });
  // On a phone one round button cycles the sizes: one, three, then two columns.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect.poll(columns).toBe(1);
  await page.getByRole('button', { name: 'Large thumbnails. Change thumbnail size' }).click();
  await expect.poll(columns).toBe(3);
  await steadyAt(0.5);
  await page.screenshot({ path: 'test-results/small-mobile.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Small thumbnails. Change thumbnail size' }).click();
  await expect.poll(columns).toBe(2);
  await expect.poll(savedSize).toBe('medium');
  // Selection still spans cards that are not rendered.
  await page.evaluate(() => scrollTo(0, 0));
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await pickImage('tile-000.png').click();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await pickImage('tile-299.png').click({ modifiers: ['Shift'] });
  await expect(bar.getByRole('status')).toHaveText(`${many} selected`);
  await page.screenshot({ path: 'test-results/windowed-grid-mobile.png', animations: 'disabled' });
  // Appearance: Automatic follows the device, Light and Dark override it, and
  // each device's choice is saved on the server.
  await page.keyboard.press('Escape');
  const room = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const savedTheme = () =>
    page.evaluate(async () => (await (await fetch('/api/preferences')).json()).theme);
  const lightRoom = 'rgb(238, 241, 244)',
    darkRoom = 'rgb(23, 27, 32)';
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => scrollTo(0, 0));
  const appearance = page.getByRole('group', { name: 'Appearance' });
  await expect(appearance.getByRole('button', { name: 'Automatic' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await room()).toBe(lightRoom);
  await appearance.getByRole('button', { name: 'Dark' }).click();
  await expect.poll(room).toBe(darkRoom);
  await expect.poll(savedTheme).toBe('dark');
  await page.screenshot({ path: 'test-results/dark-desktop.png', animations: 'disabled' });
  // A cookie mirrors the choice, so the sign-in screen is already dark. The
  // saved choice comes back from the server once the gallery unlocks.
  await page.reload();
  await expect.poll(room).toBe(darkRoom);
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await page
    .getByLabel('Vault passphrase', { exact: true })
    .fill('a new passphrase for recovery testing');
  await page.getByRole('button', { name: 'Unlock collection', exact: true }).click();
  await expect(appearance.getByRole('button', { name: 'Dark' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(room).toBe(darkRoom);
  await appearance.getByRole('button', { name: 'Automatic' }).click();
  await expect.poll(room).toBe(lightRoom);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(room).toBe(darkRoom);
  // On a phone one round button cycles Automatic, Light, Dark. An explicit
  // Light wins over a dark device.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole('button', { name: 'Appearance: Automatic. Change appearance' }).click();
  await expect.poll(room).toBe(lightRoom);
  await expect.poll(savedTheme).toBe('light');
  await page.getByRole('button', { name: 'Appearance: Light. Change appearance' }).click();
  await expect.poll(room).toBe(darkRoom);
  await page.screenshot({ path: 'test-results/dark-mobile.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Appearance: Dark. Change appearance' }).click();
  await expect.poll(savedTheme).toBe('system');
  expect(await page.evaluate(() => document.cookie)).not.toContain('stillroom-theme');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(room).toBe(lightRoom);
  expect(external).toEqual([]);
  expect(browserErrors).toEqual([]);
});
