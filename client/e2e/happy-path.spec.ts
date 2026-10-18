/**
 * Happy path: caregiver sets everything up, the patient's device recognises
 * the visitor through the camera, hears who it is, and writes a memory that
 * the caregiver then reviews.
 */
import { expect, test } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('caregiver setup -> patient "Who is this?" -> memory -> caregiver review', async ({ browser }) => {
  const email = `carer${Date.now()}@example.com`;

  // ---------------- Caregiver
  const care = await browser.newContext();
  const cg = await care.newPage();
  await cg.goto('/register');
  await cg.getByLabel('Your name').fill('Asha');
  await cg.getByLabel('Email').fill(email);
  await cg.getByLabel('Password').fill('CorrectHorse9');
  await cg.getByRole('button', { name: 'Create account' }).click();
  await expect(cg.getByRole('heading', { name: 'Your patients' })).toBeVisible();

  await cg.getByLabel('Add a patient').fill('Ravi');
  await cg.getByRole('button', { name: 'Add patient' }).click();
  await cg.getByRole('link', { name: 'Ravi' }).click();

  await cg.getByRole('link', { name: 'People' }).click();
  await cg.getByRole('button', { name: 'Add a familiar person' }).click();
  await cg.getByLabel('Name', { exact: true }).fill('Priya');
  await cg.getByLabel('Relationship to the patient').fill('daughter');
  await cg.getByLabel('Who gave consent').fill('Priya');
  await cg.getByLabel(/I confirm consent was given/).check();
  await cg.getByRole('button', { name: 'Save person' }).click();

  await expect(cg.getByRole('heading', { name: 'Priya' })).toBeVisible();
  await cg
    .getByLabel('Upload photos')
    .setInputFiles(['person-1.jpg', 'person-2.jpg', 'person-3.jpg'].map((f) => path.join(fixtures, f)));
  await cg.getByRole('button', { name: 'Check and add photos' }).click();
  await expect(cg.getByText(/person-3\.jpg: added/)).toBeVisible({ timeout: 30_000 });
  await expect(cg.getByRole('heading', { name: /Face photos \(3\/5\)/ })).toBeVisible();

  await cg.getByRole('link', { name: 'Settings' }).click();
  await cg.getByRole('button', { name: 'Create pairing code' }).click();
  const code = (await cg.getByTestId('pairing-code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // ---------------- Patient device (fake camera shows Priya)
  const device = await browser.newContext({ permissions: ['camera'] });
  const pt = await device.newPage();
  await pt.goto('/pair');
  await pt.getByLabel('Code').fill(code);
  await pt.getByRole('button', { name: 'Start' }).click();
  await expect(pt.getByRole('button', { name: 'Who is this?' })).toBeEnabled({ timeout: 20_000 });

  // Patient mode: body text is at least 20px.
  const fontSize = await pt.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(20);

  await pt.getByRole('button', { name: 'Who is this?' }).click();
  const card = pt.getByTestId('result-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('heading', { name: 'Priya' })).toBeVisible();
  await expect(card.getByText('Your daughter', { exact: true })).toBeVisible();
  await expect(card.getByText('This is Priya, your daughter.')).toBeVisible();
  await expect(pt.getByRole('button', { name: /Ask my caregiver/ }).first()).toBeVisible();
  if (process.env.E2E_SCREENSHOTS)
    await pt.screenshot({ path: 'test-results/patient-result.png', fullPage: true });

  await card.getByRole('link', { name: 'Add a memory about Priya' }).click();
  await pt.getByLabel('Write here').fill('Priya brought jasmine flowers');
  await pt.getByRole('button', { name: 'Save' }).click();
  await pt.getByRole('button', { name: 'Yes, save it' }).click();
  await expect(pt.getByRole('heading', { name: 'Saved.' })).toBeVisible();

  // ---------------- Patient plans a visit and asks about it
  await pt.getByRole('link', { name: 'Visits' }).click();
  await pt.getByRole('button', { name: 'Plan a visit' }).click();
  await pt.getByLabel('Who is coming?').selectOption({ label: 'Priya (daughter)' });
  await pt.getByRole('button', { name: 'Save visit' }).click();
  await pt.getByRole('button', { name: 'Yes, save it' }).click();
  await expect(pt.getByText('Visit saved.')).toBeVisible();
  await pt.getByRole('link', { name: 'Who is this?' }).click();
  await pt.getByLabel('Ask a question').fill('When is Priya coming?');
  await pt.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(pt.getByTestId('ask-result')).toContainText('Priya is coming tomorrow at');

  // ---------------- Caregiver reviews the patient's entry
  await cg.getByRole('link', { name: 'Review' }).click();
  await expect(cg.getByLabel('Entry text')).toHaveValue('Priya brought jasmine flowers');
  await cg.getByRole('button', { name: 'Approve' }).click();
  await expect(cg.getByText('Nothing to review.')).toBeVisible();

  // ---------------- Patient sees the approved memory next time Priya is recognised
  await pt.getByRole('button', { name: 'Who is this?' }).click();
  const history = pt.getByRole('region', { name: 'Memories with Priya' });
  await expect(history).toContainText('Priya brought jasmine flowers', { timeout: 30_000 });
  await expect(history.getByRole('button', { name: 'Tell me simply' })).toBeVisible();
  await expect(pt.getByText('Priya is coming again tomorrow')).toBeVisible();

  await cg.getByRole('link', { name: 'Overview' }).click();
  await expect(cg.getByRole('cell', { name: 'Recognised' }).first()).toBeVisible();
  if (process.env.E2E_SCREENSHOTS)
    await cg.screenshot({ path: 'test-results/caregiver-overview.png', fullPage: true });

  await care.close();
  await device.close();
});
