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
  expect(external).toEqual([]);
  expect(browserErrors).toEqual([]);
});
