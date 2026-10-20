import { expect, test } from '@playwright/test'

for (const width of [1100, 390])
  test(`starts, polls and stops a typed optimization at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 })
    await page.goto('/task-optimization.html')
    await page.getByText('Optimize task', { exact: true }).click()
    await expect(page.getByLabel('Task description', { exact: true })).toHaveValue(
      'Synthetic task session'
    )
    await page.getByLabel('Task description', { exact: true }).fill('Compute a synthetic CSV sum')
    await page
      .getByLabel('Acceptance criteria (one per line)', { exact: true })
      .fill('The output is valid JSON\nThe sum is correct')
    await page.getByLabel('Execution limit (includes two assessments)', { exact: true }).fill('12')
    await page.getByLabel('Text input files', { exact: true }).setInputFiles({
      name: 'values.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('value\n1\n2\n')
    })
    await expect(page.getByText('values.csv', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Start optimization', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Used 2 of 12 executions')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { optimizationFixture: { get: number } }).optimizationFixture.get
        )
      )
      .toBeGreaterThan(0)
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { optimizationFixture: { start: unknown[] } }).optimizationFixture
            .start[0]
      )
    ).toMatchObject({
      projectId: 'project',
      sourceSessionId: 'session',
      prompt: 'Compute a synthetic CSV sum',
      executionLimit: 12,
      files: [{ path: 'values.csv', content: 'value\n1\n2\n' }]
    })
    await page.getByRole('button', { name: 'Stop optimization', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Cancelled')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
test('shows independent assessments, opens owner-backed views and resets on Session switch', async ({
  page
}) => {
  await page.goto('/task-optimization.html?complete')
  await page.getByText('Optimize task', { exact: true }).click()
  await page
    .getByLabel('Acceptance criteria (one per line)', { exact: true })
    .fill('The output is valid')
  await page.getByRole('button', { name: 'Start optimization', exact: true }).click()
  await expect(page.getByText('Baseline assessment', { exact: true })).toBeVisible()
  await expect(page.getByText('Candidate assessment', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open assessment', exact: true }).last().click()
  await page.getByRole('button', { name: 'Open result chat 2', exact: true }).click()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { optimizationFixture: { reviews: string[]; sessions: string[] } })
          .optimizationFixture
    )
  ).toMatchObject({ reviews: ['review-candidate'], sessions: ['candidate-session'] })
  await page.getByRole('button', { name: 'Switch source chat', exact: true }).click()
  await page.getByText('Optimize task', { exact: true }).click()
  await expect(page.getByLabel('Task description', { exact: true })).toHaveValue(
    'Synthetic task next'
  )
  await expect(page.getByText('Baseline assessment', { exact: true })).toHaveCount(0)
})
test('keeps errors credential-free and hides unsupported web entry', async ({ page }) => {
  await page.goto('/task-optimization.html?error')
  await page.getByText('Optimize task', { exact: true }).click()
  await page
    .getByLabel('Acceptance criteria (one per line)', { exact: true })
    .fill('The output is valid')
  await page.getByRole('button', { name: 'Start optimization', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Check the selected model')
  await expect(page.locator('body')).not.toContainText('synthetic-secret')
  await page.goto('/task-optimization.html?web')
  await expect(page.getByTestId('task-optimization-panel')).toHaveCount(0)
})
