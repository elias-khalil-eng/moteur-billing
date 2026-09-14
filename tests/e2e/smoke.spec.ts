import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { OWNER, COLLECTOR } from './global-setup.js';

/**
 * The two flows that must never break, driven through the real interface on one
 * origin. They run in order and share the state they build: a cycle, a subscriber,
 * a reading, a bill, then a payment against it.
 */

const SUBSCRIBER_CODE = '5001';
const SUBSCRIBER_NAME = 'E2E Subscriber';
const PERIOD = '2031-03';

let subscriberPin = '';

async function useEnglish(page: Page) {
  const toggle = page.getByRole('button', { name: 'English' });
  if (await toggle.isVisible()) await toggle.click();
}

async function signInAsStaff(page: Page, account: { username: string; password: string }) {
  await page.goto('/staff/login');
  await useEnglish(page);
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
}

test.describe.configure({ mode: 'serial' });

test('owner opens a cycle, a collector reads a meter, the owner issues, the subscriber sees the bill', async ({
  page,
}) => {
  await signInAsStaff(page, OWNER);

  // A subscriber, with the PIN the owner is shown exactly once. The owner reaches
  // the subscriber list through More, which is where the secondary screens live.
  await page.getByRole('link', { name: 'More' }).click();
  await page.getByRole('link', { name: 'Subscribers' }).click();
  await page.getByRole('link', { name: 'New subscriber' }).click();
  await page.getByLabel('Subscriber number').fill(SUBSCRIBER_CODE);
  await page.getByLabel('Name').fill(SUBSCRIBER_NAME);
  await page.getByRole('button', { name: 'Save' }).click();

  const pinDialog = page.getByRole('dialog');
  await expect(pinDialog).toBeVisible();
  subscriberPin = (await pinDialog.locator('.pin-slip__line--pin strong').innerText()).trim();
  expect(subscriberPin).toMatch(/^\d{6}$/);
  await pinDialog.getByRole('button', { name: 'Close' }).click();

  // A cycle at 30 cents per kWh and 89,000 LBP to the dollar.
  await page.getByRole('link', { name: 'Cycle', exact: true }).click();
  await page.getByLabel('Month').fill(PERIOD);
  await page.getByLabel('Price per kWh in US cents').fill('30');
  await page.getByLabel('LBP per US dollar').fill('89000');
  await page.getByRole('button', { name: 'Open a cycle' }).click();
  await expect(page.getByText('Open', { exact: true })).toBeVisible();

  // The collector walks the route.
  await signOut(page);
  await signInAsStaff(page, COLLECTOR);
  await page.getByRole('link', { name: 'Meter route' }).click();
  const reading = page.getByLabel(`Current reading ${SUBSCRIBER_NAME}`);
  await reading.fill('1250');
  await reading.blur();
  await expect(page.getByText('1,250 kWh used')).toBeVisible();

  // The owner issues.
  await signOut(page);
  await signInAsStaff(page, OWNER);
  await page.getByRole('link', { name: 'Cycle', exact: true }).click();
  await page.getByRole('button', { name: 'Issue bills' }).click();
  const issueDialog = page.getByRole('dialog');
  await expect(issueDialog.getByText('$375.00')).toBeVisible();
  await issueDialog.getByRole('button', { name: 'Issue bills' }).click();
  await expect(page.getByText('Bills issued.')).toBeVisible();

  // The subscriber signs in and sees the same figures, in both currencies.
  await signOut(page);
  await page.goto('/login');
  await useEnglish(page);
  await page.getByLabel('Subscriber number').fill(SUBSCRIBER_CODE);
  await page.getByLabel('PIN').fill(subscriberPin);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('$375.00', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('33,375,000 LBP', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('1,250 kWh', { exact: true }).first()).toBeVisible();
});

test('a collector records a partial payment in LBP and the balance follows it', async ({ page }) => {
  await signInAsStaff(page, COLLECTOR);

  await page.getByRole('link', { name: 'Collect' }).click();
  await page.getByLabel('Find a subscriber').fill(SUBSCRIBER_CODE);
  await page.getByRole('button', { name: new RegExp(SUBSCRIBER_NAME) }).click();
  await expect(page.getByText('$375.00', { exact: true }).first()).toBeVisible();

  // 8,900,000 LBP at 89,000 to the dollar is $100 of the $375 owed.
  await page.getByRole('button', { name: 'LBP', exact: true }).click();
  await page.getByLabel('Amount in LBP').fill('8900000');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();

  await signOut(page);
  await page.goto('/login');
  await useEnglish(page);
  await page.getByLabel('Subscriber number').fill(SUBSCRIBER_CODE);
  await page.getByLabel('PIN').fill(subscriberPin);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('Total you owe')).toBeVisible();
  await expect(page.getByText('$275.00', { exact: true }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Payments' }).click();
  // The amount sits next to the LBP figure in the same cell, so this is a partial match.
  await expect(page.getByText('$100.00').first()).toBeVisible();
});
