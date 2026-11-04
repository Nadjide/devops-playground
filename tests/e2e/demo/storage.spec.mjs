import { expect, expectNoHorizontalOverflow, test } from './fixtures.mjs';

const objective = (page, label) => page.getByRole('listitem').filter({ hasText: label });

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

test('completes the S3 provisioning mission through the Cloud panel and the service check', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await chooseMission(page, 'storage-provision');
  await expect(page.getByRole('heading', { name: 'Provision storage for a service' })).toBeVisible();
  const cloud = await openCloud(page);
  await expect(cloud.getByLabel('Storage backend')).toBeVisible();
  await expect(cloud).toContainText('AWS S3');
  await expect(cloud).toContainText('http://storage:5000');
  await expect(cloud.getByText('Simulated', { exact: true }).first()).toBeVisible();

  // The service cannot reach its bucket yet.
  await cloud.getByRole('button', { name: 'Run storage check' }).click();
  await expect(cloud.getByLabel('Latest storage check')).toContainText('NoSuchBucket');

  // Provider naming rules come back as S3 errors.
  const create = cloud.getByRole('form', { name: 'Create bucket' });
  await create.getByLabel('New bucket').fill('Lab_Reports');
  await create.getByRole('button', { name: 'Create bucket' }).click();
  await expect(create.getByRole('alert')).toContainText('InvalidBucketName');
  await create.getByLabel('New bucket').fill('lab-reports');
  await create.getByRole('button', { name: 'Create bucket' }).click();
  await expect(objective(page, 'Create the bucket the reports service is configured for')).toContainText('Satisfied');

  // Listing alone proves nothing about the service.
  await expect(objective(page, "Verify the service's own write and read")).toContainText('Pending');

  const write = cloud.getByRole('form', { name: 'Write object to lab-reports' });
  await write.getByLabel('Key').fill('notes.txt');
  await write.getByLabel('Text content').fill('Quarterly report ready');
  await write.getByRole('button', { name: 'Write object' }).click();
  await cloud.getByRole('button', { name: 'Read notes.txt' }).click();
  await expect(cloud.getByRole('region', { name: 'Content of notes.txt' })).toContainText('Quarterly report ready');
  await expect(objective(page, 'Write a text object and read the same content back')).toContainText('Satisfied');

  await cloud.getByRole('button', { name: 'Run storage check' }).click();
  await expect(cloud.getByLabel('Latest storage check')).toContainText('round trip passed');
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible();
  await expect(cloud.getByRole('list', { name: 'Objects in lab-reports' })).toContainText('storage-check.txt');
});

test('repairs the S3 configuration incident and refuses unsafe changes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await chooseMission(page, 'storage-config');
  await expect(page.getByRole('heading', { name: 'Repair a storage configuration' })).toBeVisible();

  await terminal(page, 'docker logs api --tail 5');
  await expect(objective(page, 'Find the storage error')).toContainText('Satisfied');
  await terminal(page, 'aws s3 ls');
  await expect(page.getByTestId('terminal-host')).toContainText('shared-audit-logs   (not owned by this lab)');

  const cloud = await openCloud(page);
  const form = cloud.getByRole('form', { name: 'api storage configuration' });
  await expect(form.getByLabel('Bucket')).toHaveValue('lab-report');

  // External endpoints and foreign buckets are refused before anything changes.
  await form.getByLabel('Endpoint').fill('https://s3.amazonaws.com');
  await form.getByRole('button', { name: 'Apply storage configuration' }).click();
  await expect(form.getByRole('alert')).toContainText("is not the session's AWS S3 emulator");
  await form.getByLabel('Endpoint').fill('http://storage:5000');
  await form.getByLabel('Bucket').fill('shared-audit-logs');
  await form.getByRole('button', { name: 'Apply storage configuration' }).click();
  await expect(form.getByRole('alert')).toContainText('owned by this lab');

  // Deleting a foreign bucket is not offered; deleting a non-empty owned one asks first, then S3 refuses.
  await cloud.getByRole('button', { name: 'Delete bucket lab-reports' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete bucket' }).click();
  await expect(cloud).toContainText('BucketNotEmpty');

  await form.getByLabel('Bucket').fill('lab-reports');
  await form.getByRole('button', { name: 'Apply storage configuration' }).click();
  await expect(objective(page, 'Point the service at the bucket that holds its reports')).toContainText('Satisfied');
  await terminal(page, 'curl http://api:3000/storage-check');
  await expect(page.getByRole('complementary', { name: 'Mission' }).getByText('Mission complete')).toBeVisible();
  await terminal(page, 'aws s3 cp s3://lab-reports/storage-check.txt -');
  await expect(page.getByTestId('terminal-host')).toContainText('namespace=lab-reports');
});

test('keeps the Cloud panel usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await chooseMission(page, 'storage-provision');
  await page.getByRole('tablist', { name: 'Workbench panels' }).getByRole('tab', { name: 'Cloud' }).click();
  const cloud = page.locator('.cloud-panel');
  await cloud.getByLabel('New bucket').fill('lab-reports');
  await cloud.getByRole('button', { name: 'Create bucket' }).click();
  await expect(cloud.getByRole('list', { name: 'Buckets' })).toContainText('lab-reports');
  await expectNoHorizontalOverflow(page);
});

test('migrates saved progress from before cloud storage', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Read logs of api' }).click();
  await expect(objective(page, 'Inspect the service logs')).toContainText('Satisfied');
  // Rewrite the saved checkpoint as the previous format, then reload.
  await page.evaluate(() => {
    const key = 'devops-playground:demo-checkpoint:v1';
    const saved = JSON.parse(localStorage.getItem(key));
    const { storage, ...session } = saved.session;
    if (storage !== null) {
      throw new Error('core sessions have no storage');
    }
    localStorage.setItem(key, JSON.stringify({ checkpointVersion: 1, savedAt: saved.savedAt, session: { ...session, schemaVersion: 1 } }));
  });
  await page.reload();
  await expect(page.getByText(/Restored your saved demo session/)).toBeVisible();
  await expect(objective(page, 'Inspect the service logs')).toContainText('Satisfied');
});
