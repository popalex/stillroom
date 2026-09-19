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
  await page.screenshot({ path: 'test-results/gallery-desktop.png', fullPage: true });

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
  await expect(viewer.getByRole('button', { name: 'Delete category', exact: true })).toHaveCount(0);
  await viewer.getByRole('combobox', { name: 'Sort by', exact: true }).selectOption('name-desc');
  await expect(viewer.getByRole('combobox', { name: 'Sort by', exact: true })).toBeEnabled();
  expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await viewer.screenshot({ path: 'test-results/gallery-mobile.png', fullPage: true });
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
  await page.getByRole('button', { name: 'View alpha.png' }).click();
  await page.getByRole('button', { name: 'Next image' }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('photo2.png');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search photographs' }).fill('photo');
  await expect(names).toHaveText(['photo2.png', 'photo10.png']);
  await page.getByRole('searchbox', { name: 'Search photographs' }).fill('');
  await page.getByRole('button', { name: /^Private walks/ }).click();
  await expect(names).toHaveCount(0);
  await page.getByRole('button', { name: /^All photographs/ }).click();
  await expect(names).toHaveText(['alpha.png', 'photo2.png', 'photo10.png']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/sorting-mobile.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await page
    .getByLabel('Vault passphrase', { exact: true })
    .fill('a new passphrase for recovery testing');
  await page.getByRole('button', { name: 'Unlock collection', exact: true }).click();
  await expect(sort).toHaveValue('name-asc');
  await expect(names).toHaveText(['alpha.png', 'photo2.png', 'photo10.png']);
  await expect(page.getByRole('button', { name: 'Delete category', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Private walks/ }).click();
  await page.getByRole('button', { name: 'Delete category', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('all 0 images');
  await page.getByRole('button', { name: 'Permanently delete category', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Private walks/ })).toHaveCount(0);
  await expect(names).toHaveText(['alpha.png', 'photo2.png', 'photo10.png']);

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
  await page.getByRole('searchbox', { name: 'Search photographs' }).fill('alpha');
  await expect(names).toHaveText(['alpha.png']);
  await expect(page.getByRole('button', { name: 'Delete category', exact: true })).toBeInViewport({
    ratio: 1,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/category-actions-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Delete category', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('"To delete" and all 2 images');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(names).toHaveText(['alpha.png']);
  await page.getByRole('button', { name: 'Delete category', exact: true }).click();
  const deletionRequest = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith('/api/catalog'),
  );
  await page.getByRole('button', { name: 'Permanently delete category', exact: true }).click();
  expect((await deletionRequest).postDataJSON().deleteObjects).toHaveLength(6);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^To delete/ })).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search photographs' })).toHaveValue('');
  await expect(names).toHaveText(['photo10.png']);
  await page.reload();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await page
    .getByLabel('Vault passphrase', { exact: true })
    .fill('a new passphrase for recovery testing');
  await page.getByRole('button', { name: 'Unlock collection', exact: true }).click();
  await expect(names).toHaveText(['photo10.png']);
  await expect(page.getByRole('button', { name: /^To delete|^Private walks/ })).toHaveCount(0);
  expect(external).toEqual([]);
  expect(browserErrors).toEqual([]);
});
