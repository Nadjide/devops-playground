import { expect, test } from './fixtures.mjs';

const objective = (page, label) => page.getByRole('listitem').filter({ hasText: label });
const mission = (page) => page.getByRole('complementary', { name: 'Mission' });

async function chooseMission(page, labId) {
  await page.getByRole('combobox', { name: 'Mission' }).selectOption(labId);
  await page.getByRole('button', { name: 'Start new session' }).click();
}

async function terminal(page, command) {
  await page.getByTestId('terminal-host').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

async function openCloud(page) {
  await page.getByRole('tablist', { name: 'Operations panels' }).getByRole('tab', { name: 'Cloud' }).click();
  return page.locator('.cloud-panel');
}

test('completes the Azure Blob provisioning mission with container and blob terminology', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await chooseMission(page, 'blob-provision');
  await expect(page.getByRole('heading', { name: 'Provision storage for a service (Azure Blob)' })).toBeVisible();
  const cloud = await openCloud(page);
  await expect(cloud.getByLabel('Storage backend')).toContainText('Azure Blob');
  await expect(cloud.getByLabel('Storage backend')).toContainText('http://storage:10000/devstoreaccount1');

  await terminal(page, 'az storage container create -n Lab.Reports');
  await expect(page.getByTestId('terminal-host')).toContainText('InvalidResourceName');
  await terminal(page, 'az storage container create -n lab-reports');
  await expect(page.getByTestId('terminal-host')).toContainText('"created": true');
  await expect(objective(page, 'Create the container the reports service is configured for')).toContainText('Satisfied');

  const upload = cloud.getByRole('form', { name: 'Write blob to lab-reports' });
  await upload.getByLabel('Text content').fill('Blob report ready');
  await upload.getByRole('button', { name: 'Write blob' }).click();
  await terminal(page, 'az storage blob download -c lab-reports -n notes.txt');
  await expect(page.getByTestId('terminal-host')).toContainText('Blob report ready');
  await expect(objective(page, 'Upload a text blob and download the same content')).toContainText('Satisfied');

  await terminal(page, 'curl http://api:3000/storage-check');
  await expect(mission(page).getByText('Mission complete')).toBeVisible();
  await expect(cloud.getByRole('list', { name: 'Blobs in lab-reports' })).toContainText('storage-check.txt');

  // Azure deletes a container together with its blobs, after confirmation.
  await cloud.getByRole('button', { name: 'Delete container lab-reports' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Every blob in lab-reports is deleted with it.');
  await dialog.getByRole('button', { name: 'Delete container' }).click();
  await expect(cloud.getByRole('list', { name: 'Containers' })).not.toContainText('lab-reports');
});

test('repairs the Azure configuration incident', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await chooseMission(page, 'blob-config');
  await page.getByRole('tablist', { name: 'Observation panels' }).getByRole('tab', { name: 'Logs' }).click();
  await expect(page.getByText(/ContainerNotFound/).first()).toBeVisible();
  await expect(objective(page, 'Find the storage error')).toContainText('Satisfied');

  const cloud = await openCloud(page);
  const form = cloud.getByRole('form', { name: 'api storage configuration' });
  await form.getByLabel('Container').fill('lab-reports');
  await form.getByRole('button', { name: 'Apply storage configuration' }).click();
  await expect(objective(page, 'Point the service at the container that holds its reports')).toContainText('Satisfied');
  await cloud.getByRole('button', { name: 'Run storage check' }).click();
  await expect(cloud.getByLabel('Latest storage check')).toContainText('round trip passed');
  await expect(mission(page).getByText('Mission complete')).toBeVisible();
});

test('switches provider through a confirmed new session without carrying evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await chooseMission(page, 'storage-provision');
  const cloud = await openCloud(page);
  await cloud.getByLabel('New bucket').fill('lab-reports');
  await cloud.getByRole('button', { name: 'Create bucket' }).click();
  await expect(objective(page, 'Create the bucket')).toContainText('Satisfied');

  const providers = cloud.getByRole('group', { name: 'Storage provider' });
  await expect(providers.getByRole('button', { name: 'AWS S3' })).toHaveAttribute('aria-pressed', 'true');
  await providers.getByRole('button', { name: 'Azure Blob' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Provision storage for a service (Azure Blob)');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(providers.getByRole('button', { name: 'AWS S3' })).toHaveAttribute('aria-pressed', 'true');

  await providers.getByRole('button', { name: 'Azure Blob' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start new session' }).click();
  await expect(page.getByRole('heading', { name: 'Provision storage for a service (Azure Blob)' })).toBeVisible();
  await expect(cloud.getByRole('list', { name: 'Containers' })).not.toContainText('lab-reports');
  await expect(objective(page, 'Create the container')).toContainText('Pending');

  // The Azure session is what a reload restores.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Provision storage for a service (Azure Blob)' })).toBeVisible();
  await expect(page.getByText(/Restored your saved demo session/)).toBeVisible();
});
