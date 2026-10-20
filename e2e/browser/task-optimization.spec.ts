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
    await page.getByRole('button', { name: 'Preview task stream', exact: true }).click()
    await page.getByRole('button', { name: 'Start optimization', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Used 2 of 12 executions')
    await expect(
      page.getByText('Used 2 of 12 executions · 1 active', { exact: true })
    ).toBeInViewport({ ratio: 1 })
    await expect(
      page.getByRole('button', { name: 'Stop optimization', exact: true })
    ).toBeInViewport({ ratio: 1 })
    await expect
      .poll(() => page.getByTestId('task-optimization-panel').evaluate((node) => node.scrollTop))
      .toBe(0)
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
          (window as unknown as { optimizationFixture: { sweeps: unknown[] } }).optimizationFixture
            .sweeps[0]
      )
    ).toMatchObject({
      projectId: 'project',
      sourceSessionId: 'session',
      executionLimit: 12,
      catalog: [
        {
          taskId: 'task-0001',
          domain: 'research',
          sourceSessionId: 'session',
          source: {
            kind: 'text',
            prompt: 'Compute a synthetic CSV sum',
            files: [{ path: 'values.csv', content: 'value\n1\n2\n' }]
          }
        }
      ]
    })
    const polled = await page.evaluate(
      () => (window as unknown as { optimizationFixture: { get: number } }).optimizationFixture.get
    )
    const scrolled = await page.getByTestId('task-optimization-panel').evaluate((node) => {
      node.scrollTop = 80
      return node.scrollTop
    })
    expect(scrolled).toBeGreaterThan(0)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { optimizationFixture: { get: number } }).optimizationFixture.get
        )
      )
      .toBeGreaterThan(polled)
    expect(
      await page.getByTestId('task-optimization-panel').evaluate((node) => node.scrollTop)
    ).toBe(scrolled)
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
  await page.getByRole('button', { name: 'Preview task stream', exact: true }).click()
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
  await page.getByRole('button', { name: 'Preview task stream', exact: true }).click()
  await page.getByRole('button', { name: 'Start optimization', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Check the selected model')
  await expect(page.locator('body')).not.toContainText('synthetic-secret')
  await page.goto('/task-optimization.html?web')
  await expect(page.getByTestId('task-optimization-panel')).toHaveCount(0)
})

for (const mode of ['sequential', 'parallel']) {
  test(`submits ${mode} k2 and displays the original selector result`, async ({ page }) => {
    await page.goto('/task-optimization.html?complete')
    await page.getByText('Optimize task', { exact: true }).click()
    await page.getByLabel('Optimization mode', { exact: true }).selectOption(mode)
    await page.getByLabel('Recursion parameter (k)', { exact: true }).fill('2')
    await page.getByLabel('Concurrent executions', { exact: true }).fill('2')
    const budget = page.getByLabel('Execution limit (includes two assessments)', { exact: true })
    await expect(budget).toHaveValue('12')
    await budget.fill('20')
    await page
      .getByLabel('Acceptance criteria (one per line)', { exact: true })
      .fill('The requested output is complete')
    await page.getByRole('button', { name: 'Preview task stream', exact: true }).click()
    await page.getByRole('button', { name: 'Start optimization', exact: true }).click()
    await expect(page.getByText('Selector comparison', { exact: true })).toBeVisible()
    await expect(
      page.getByText(`Selected ${mode === 'parallel' ? 'agg2' : 'c2'} from 2 candidates`, {
        exact: true
      })
    ).toBeVisible()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { optimizationFixture: { sweeps: unknown[] } }).optimizationFixture
            .sweeps[0]
      )
    ).toMatchObject({ sweep: { modes: [mode], k: 2, concurrency: 2 }, executionLimit: 20 })
  })
}

test('keeps domain admission scoped to each task and submits private JSON expectations', async ({
  page
}) => {
  await page.goto('/task-optimization.html?complete')
  await page.getByText('Optimize task', { exact: true }).click()
  await page.getByLabel('Acceptance criteria (one per line)', { exact: true }).fill('Correct count')
  await page.getByLabel('Domain', { exact: true }).first().fill('csv-count')
  await page.getByRole('button', { name: 'Add next task', exact: true }).click()
  await page
    .getByLabel('Next task description 1', { exact: true })
    .fill('Count the second data set')
  await page.getByLabel('Next task criteria 1', { exact: true }).fill('Correct second count')
  await page.getByLabel('Check expected JSON output', { exact: true }).first().check()
  await page.getByLabel('Expected JSON value', { exact: true }).fill('{"count":3}')
  await expect(
    page.getByLabel('Shared execution limit (all task assessments and reflections)', {
      exact: true
    })
  ).toHaveValue('12')
  await page.getByRole('button', { name: 'Preview task stream', exact: true }).click()
  await page.getByRole('button', { name: 'Start optimization', exact: true }).click()
  const results = page.getByTestId('domain-results')
  const tasks = results.locator('section')
  await expect(tasks.first()).toContainText('Eligible for further configuration validation')
  await expect(tasks.last()).toContainText('Configuration admission blocked')
  await expect(tasks.last()).toContainText('An expected output check failed.')
  await expect(page.getByTestId('research-outcome')).toHaveCount(2)
  await expect(
    page.getByText('Eligible for further configuration validation', { exact: true })
  ).toHaveCount(1)
  await expect(page.getByRole('status')).not.toContainText('output-check-failed')
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { optimizationFixture: { sweeps: unknown[] } }).optimizationFixture
          .sweeps[0]
    )
  ).toMatchObject({
    executionLimit: 20,
    catalog: [
      {
        taskId: 'task-0001',
        domain: 'csv-count',
        checks: [{ kind: 'json-value', path: 'result.json', pointer: '', expected: { count: 3 } }]
      },
      {
        taskId: 'task-0002',
        domain: 'csv-count',
        criteria: 'Correct second count',
        source: { kind: 'text', prompt: 'Count the second data set', files: [] }
      }
    ]
  })
})
