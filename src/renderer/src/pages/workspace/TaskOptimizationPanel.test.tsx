// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  DesktopOptimizationApi,
  OptimizationProgress
} from '../../../../shared/earthnano/desktop-optimization'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../../shared/web-event-connection'
import { TaskOptimizationPanel } from './TaskOptimizationPanel'
import { minimumSweepExecutions } from '../../../../shared/earthnano/optimization-sweep'
import type { CatalogSessionApi } from './OptimizationCatalogSource'
import type {
  PersistedChatSession,
  PersistedArtifact
} from '../../../../shared/session-persistence'
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key.replace(/{{(.*?)}}/g, (_all, name) => String(values?.[name] ?? ''))
  })
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root, api: DesktopOptimizationApi, sessions: CatalogSessionApi
const progress = (state: OptimizationProgress['state'] = 'running'): OptimizationProgress => ({
  runId: 'run',
  projectId: 'project',
  sourceSessionId: 'session',
  state,
  stage: 'baseline',
  budget: { limit: 12, admitted: 1, completed: 0, active: 1 },
  executions: [
    { executionId: 'baseline', role: 'baseline', phase: 'running', sessionId: 'result-session' }
  ],
  updatedAt: 1
})
const render = async (sessionId = 'session', artifacts?: PersistedArtifact[]): Promise<void> => {
  await act(async () =>
    root.render(
      <TaskOptimizationPanel
        projectId="project"
        sessionId={sessionId}
        initialPrompt={`Task ${sessionId}`}
        sourcePromptMessageId="source-prompt"
        artifacts={artifacts}
        api={api}
        sessions={sessions}
      />
    )
  )
}
const input = async (label: string, value: string): Promise<void> => {
  const node = container.querySelector(`[aria-label="${label}"]`) as
    HTMLInputElement | HTMLTextAreaElement
  const prototype =
    node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = async (text: string): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === text
  )!
  await act(async () => button.click())
}
const sourceSession = (id = 'session', promptId = 'source-prompt'): PersistedChatSession => ({
  id,
  projectId: 'project',
  title: `Science ${id}`,
  cwd: '/workspace',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    {
      id: promptId,
      role: 'user',
      content: `Task ${id}`,
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1,
      uploads: [
        {
          id: `upload-${id}`,
          versionId: `version-${id}`,
          sessionId: id,
          name: 'measurements.csv',
          originalName: 'measurements.csv',
          size: 10,
          sha256: 'a'.repeat(64)
        }
      ]
    }
  ]
})
beforeEach(() => {
  vi.useFakeTimers()
  sessions = {
    list: vi.fn().mockResolvedValue({
      sessions: [
        { id: 'session', projectId: 'project', title: 'Science session' },
        { id: 'another', projectId: 'project', title: 'Science another' }
      ]
    }),
    loadOne: vi.fn(async ({ sessionId }) =>
      sourceSession(sessionId, sessionId === 'another' ? 'other-prompt' : 'source-prompt')
    )
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  api = {
    previewSweep: vi.fn(async (request: Parameters<DesktopOptimizationApi['previewSweep']>[0]) => ({
      planDigest: `sha256:${'a'.repeat(64)}`,
      order: [{ domain: request.catalog[0].domain, taskIds: request.catalog.map((t) => t.taskId) }],
      modes: request.sweep.modes,
      minimumExecutions: minimumSweepExecutions(request.sweep, request.catalog.length)
    })),
    start: vi.fn().mockResolvedValue(progress()),
    startSweep: vi.fn().mockResolvedValue(progress()),
    get: vi.fn().mockResolvedValue(progress()),
    latest: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(progress('cancelled')),
    resume: vi.fn().mockResolvedValue(progress('queued'))
  }
})
it('shows observed token coverage and keeps unknown API/cost separate from execution admissions', async () => {
  vi.mocked(api.latest).mockResolvedValue({
    ...progress('completed'),
    usage: {
      admittedExecutions: 2,
      ambiguousExecutions: 0,
      tokens: {
        status: 'partial',
        coveredExecutions: 1,
        inputTokens: 7,
        cacheTokens: 5,
        outputTokens: 4
      },
      modelTurns: { status: 'partial', coveredExecutions: 1, total: 2 },
      apiRequests: { status: 'unknown', coveredExecutions: 0 },
      costMicrousd: { status: 'unknown', coveredExecutions: 0 }
    }
  })
  await render()
  const usage = container.querySelector('[data-testid="optimization-usage"]')!
  expect(usage.textContent).toContain('Input 7 · cache 5 · output 4 tokens')
  expect(usage.textContent).toContain('Token coverage: 1/2 executions')
  expect(usage.textContent).toContain('Model turns: 2 (1/2 executions)')
  expect(usage.textContent).toContain('API requests: Unknown')
  expect(usage.textContent).toContain('Cost (USD): Unknown')
  expect(api.start).not.toHaveBeenCalled()
})
it('resumes the original experiment key without forwarding edited task or budget controls', async () => {
  vi.mocked(api.latest).mockResolvedValue({ ...progress('cancelled'), resumeAvailable: true })
  await render()
  await input('Task description', 'A different task')
  await input('Execution limit (includes two assessments)', '128')
  await click('Resume optimization')
  expect(api.resume).toHaveBeenCalledExactlyOnceWith({
    projectId: 'project',
    sourceSessionId: 'session',
    runId: 'run'
  })
  expect(api.start).not.toHaveBeenCalled()
})
it('selects a fixed saved version without copying content or trusting a host path', async () => {
  await render('session', [
    {
      id: 'version',
      artifactId: 'artifact',
      versionId: 'version',
      versionNumber: 1,
      kind: 'managed-file',
      path: '/private/source.json',
      name: 'source.json',
      sha256: 'a'.repeat(64),
      size: 12
    }
  ])
  const checkbox = container.querySelector(
    '[data-testid="optimization-source-artifacts"] input'
  ) as HTMLInputElement
  await act(async () => checkbox.click())
  await input('Acceptance criteria (one per line)', 'Preserve source values')
  await click('Preview task stream')
  await click('Start optimization')
  expect(api.startSweep).toHaveBeenCalledWith(
    expect.objectContaining({
      catalog: [
        expect.objectContaining({
          source: {
            kind: 'text',
            prompt: 'Task session',
            inputArtifacts: [
              {
                artifactId: 'artifact',
                versionId: 'version',
                path: 'source.json',
                checksum: 'a'.repeat(64)
              }
            ],
            files: []
          }
        })
      ]
    })
  )
  expect(JSON.stringify(vi.mocked(api.startSweep).mock.calls)).not.toContain('/private/source.json')
})
afterEach(async () => {
  expect(api.start).not.toHaveBeenCalled()
  for (const [request] of vi.mocked(api.startSweep).mock.calls)
    expect(request).toHaveProperty('previewPlanDigest')
  await act(async () => root.unmount())
  container.remove()
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
  vi.useRealTimers()
})
it('starts a bounded task using edited inputs, polls typed progress and stops', async () => {
  await render()
  expect(
    (container.querySelector('[aria-label="Task description"]') as HTMLTextAreaElement).value
  ).toBe('Task session')
  await input('Task description', 'Edited task')
  await input('Acceptance criteria (one per line)', 'Output is valid JSON\nThe answer equals 42')
  await input('Execution limit (includes two assessments)', '12')
  await click('Preview task stream')
  await click('Start optimization')
  expect(api.startSweep).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'project',
      sourceSessionId: 'session',
      executionLimit: 12,
      requestKey: expect.any(String),
      catalog: [
        {
          taskId: 'task-0001',
          domain: 'research',
          sourceSessionId: 'session',
          source: { kind: 'text', prompt: 'Edited task', files: [] },
          criteria: 'Output is valid JSON\nThe answer equals 42'
        }
      ],
      sweep: expect.objectContaining({ modes: ['sequential'] })
    })
  )
  expect(api.start).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(api.get).toHaveBeenCalledWith({
    projectId: 'project',
    sourceSessionId: 'session',
    runId: 'run'
  })
  expect(container.textContent).toContain('Used 1 of 12 executions')
  await click('Stop optimization')
  expect(api.stop).toHaveBeenCalledWith({
    projectId: 'project',
    sourceSessionId: 'session',
    runId: 'run'
  })
  expect(container.textContent).toContain('Cancelled')
})
it('requires 1–16 criteria and a sufficient execution budget, and shows safe errors', async () => {
  await render()
  await input('Acceptance criteria (one per line)', 'criterion')
  await input('Execution limit (includes two assessments)', '8')
  expect(
    [...container.querySelectorAll('button')].find(
      (node) => node.textContent === 'Start optimization'
    )?.disabled
  ).toBe(true)
  await input('Execution limit (includes two assessments)', '9')
  vi.mocked(api.startSweep).mockRejectedValue(new Error('synthetic-provider-secret'))
  await click('Preview task stream')
  await click('Start optimization')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Check the selected model'
  )
  expect(container.textContent).not.toContain('synthetic-provider-secret')
})
it('discards a previous Session response after switching and cleans up polling', async () => {
  let resolve!: (value: OptimizationProgress) => void
  vi.mocked(api.latest)
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    .mockResolvedValueOnce(null)
  await render()
  await render('next')
  await act(async () => resolve(progress()))
  expect(container.textContent).not.toContain('Used 1 of 12')
  expect(
    (container.querySelector('[aria-label="Task description"]') as HTMLTextAreaElement).value
  ).toBe('Task next')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(api.get).not.toHaveBeenCalled()
})
it('hides on web even when an API-shaped stub exists', async () => {
  document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
  await render()
  expect(container.textContent).toBe('')
  expect(api.latest).not.toHaveBeenCalled()
})
it('reads only text attachments and rejects binary profiles without invoking the backend', async () => {
  await render()
  const file = new File(['synthetic'], 'values.csv', { type: 'text/csv' })
  Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue('value\n1\n') })
  const control = container.querySelector('input[type=file]')!
  await act(async () => {
    Object.defineProperty(control, 'files', { configurable: true, value: [file] })
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(file.text).toHaveBeenCalled()
  expect(container.textContent).toContain('values.csv')
  const binary = new File(['binary'], 'program.exe')
  await act(async () => {
    Object.defineProperty(control, 'files', { configurable: true, value: [binary] })
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(container.querySelector('[role=alert]')).not.toBeNull()
  expect(api.start).not.toHaveBeenCalled()
})

it('hides the unsupported Windows execution profile', async () => {
  const previous = window.api
  Object.defineProperty(window, 'api', { configurable: true, value: { platform: 'win32' } })
  try {
    await render()
    expect(container.textContent).toBe('')
    expect(api.latest).not.toHaveBeenCalled()
  } finally {
    Object.defineProperty(window, 'api', { configurable: true, value: previous })
  }
})

it('enforces the small desktop text profile before dispatch: 64 KB per file and 128 KB total', async () => {
  await render()
  const control = container.querySelector('input[type=file]')!
  const oversized = new File(['x'.repeat(64_001)], 'large.txt')
  const read = vi.fn()
  Object.defineProperty(oversized, 'text', { value: read })
  await act(async () => {
    Object.defineProperty(control, 'files', { configurable: true, value: [oversized] })
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(read).not.toHaveBeenCalled()
  expect(container.querySelector('[role=alert]')).not.toBeNull()
  const batch = [1, 2, 3].map((index) => {
    const content = 'x'.repeat(64_000),
      file = new File([content], `input${index}.txt`)
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(content) })
    return file
  })
  await act(async () => {
    Object.defineProperty(control, 'files', { configurable: true, value: batch })
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(container.querySelector('[role=alert]')).not.toBeNull()
  expect(container.textContent).not.toContain('input1.txt')
  expect(api.start).not.toHaveBeenCalled()
})

it('puts progress and stop before configuration, resets scroll only for a new run', async () => {
  await render()
  await input('Acceptance criteria (one per line)', 'Synthetic criterion')
  const panel = container.querySelector('details')!
  panel.scrollTop = 180
  await click('Preview task stream')
  await click('Start optimization')
  expect(panel.scrollTop).toBe(0)
  const status = container.querySelector('[role=status]')!
  const description = container.querySelector('[aria-label="Task description"]')!
  expect(
    status.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  expect(status.textContent).toContain('Stop optimization')
  panel.scrollTop = 85
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(panel.scrollTop).toBe(85)
  await click('Stop optimization')
  expect(panel.scrollTop).toBe(85)
  vi.mocked(api.startSweep).mockResolvedValue({ ...progress(), runId: 'next-run' })
  await click('Preview task stream')
  await click('Start optimization')
  expect(panel.scrollTop).toBe(0)
})

it.each(['sequential', 'parallel'] as const)(
  'submits %s k=2 with explicit concurrency and sufficient budget',
  async (mode) => {
    await render()
    await input('Acceptance criteria (one per line)', 'criterion')
    const select = container.querySelector('[aria-label="Optimization mode"]') as HTMLSelectElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, mode)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await input('Recursion parameter (k)', '2')
    await input('Concurrent executions', '3')
    const executionLimit = container.querySelector(
      '[aria-label="Execution limit (includes two assessments)"]'
    ) as HTMLInputElement
    await click('Preview task stream')
    expect(executionLimit.value).toBe('18')
    expect(executionLimit.max).toBe('512')
    expect(container.textContent).toContain('First attempts require 18 executions')
    await input('Execution limit (includes two assessments)', '16')
    await click('Start optimization')
    expect(api.start).not.toHaveBeenCalled()
    await input('Execution limit (includes two assessments)', '20')
    await click('Preview task stream')
    await click('Start optimization')
    expect(api.startSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        sweep: expect.objectContaining({ modes: [mode], k: 2, concurrency: 3 }),
        executionLimit: 20
      })
    )
  }
)
it('shows persisted upstream selection, method and exact stage identifiers', async () => {
  vi.mocked(api.latest).mockResolvedValue({
    ...progress('completed'),
    method: { mode: 'parallel', k: 2, concurrency: 2 },
    executions: [
      { executionId: 's', role: 'selector', stageId: 'select_final', phase: 'completed' }
    ],
    selection: {
      chosenLabel: 'final2',
      candidateCount: 2,
      trivial: false,
      fallback: true,
      reason: 'Selector recovery reason'
    }
  })
  await render()
  expect(container.textContent).toContain('Method: Parallel · k=2 · concurrency=2')
  expect(container.textContent).toContain('Selected final2 from 2 candidates')
  expect(container.textContent).toContain('Selector comparison')
  expect(container.textContent).toContain('Selection fallback')
  expect(container.textContent).toContain('Selector recovery reason')
  expect(container.textContent).toContain('Stage: select_final')
})

it.each(['snapshot', 'error'] as const)(
  'discards a pre-Stop polling %s after Stop is acknowledged and keeps polling',
  async (kind) => {
    vi.mocked(api.latest).mockResolvedValue(progress())
    vi.mocked(api.stop).mockResolvedValue(progress('stopping'))
    let resolve!: (value: OptimizationProgress) => void
    let reject!: (error: Error) => void
    vi.mocked(api.get)
      .mockReturnValueOnce(
        new Promise((done, fail) => {
          resolve = done
          reject = fail
        })
      )
      .mockResolvedValue(progress('cancelled'))
    await render()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(api.get).toHaveBeenCalledOnce()
    await click('Stop optimization')
    expect(container.querySelector('[role=status]')?.textContent).toContain('Stopping')
    await act(async () => {
      if (kind === 'snapshot') resolve(progress())
      else reject(new Error('Old poll failed'))
    })
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === 'Stop optimization'
    )!
    expect(button.disabled).toBe(true)
    expect(container.querySelector('[role=status]')?.textContent).toContain('Stopping')
    expect(container.querySelector('[role=alert]')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role=status]')?.textContent).toContain('Cancelled')
  }
)
it('also discards a snapshot requested while Stop was pending after its acknowledgement', async () => {
  vi.mocked(api.latest).mockResolvedValue(progress())
  let finishStop!: (value: OptimizationProgress) => void
  vi.mocked(api.stop).mockReturnValue(
    new Promise((done) => {
      finishStop = done
    })
  )
  let finishPoll!: (value: OptimizationProgress) => void
  vi.mocked(api.get)
    .mockReturnValueOnce(
      new Promise((done) => {
        finishPoll = done
      })
    )
    .mockResolvedValue(progress('cancelled'))
  await render()
  await click('Stop optimization')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(api.get).toHaveBeenCalledOnce()
  await act(async () => {
    finishStop(progress('stopping'))
  })
  await act(async () => {
    finishPoll(progress())
  })
  expect(container.querySelector('[role=status]')?.textContent).toContain('Stopping')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(container.querySelector('[role=status]')?.textContent).toContain('Cancelled')
})

it('submits a bounded ordered domain stream with private expected JSON checks, copied files and one Stop', async () => {
  await render()
  await input('Acceptance criteria (one per line)', 'Correct count')
  await input('Domain', 'csv-count')
  await click('Add next task')
  await input('Next task description 1', 'Count a second data set')
  await input('Next task criteria 1', 'Second count is correct')
  const file = new File(['value\n1'], 'values.csv')
  Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue('value\n1') })
  const fileControl = container.querySelector('input[type=file]')!
  await act(async () => {
    Object.defineProperty(fileControl, 'files', { configurable: true, value: [file] })
    fileControl.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const checkbox = container.querySelector(
    '[aria-label="Check expected JSON output"]'
  ) as HTMLInputElement
  await act(async () => checkbox.click())
  await input('Expected JSON value', '{"count":1}')
  const nextCheckbox = container.querySelector(
    '[data-testid="optimization-catalog-task-task-0002"] [aria-label="Check expected JSON output"]'
  ) as HTMLInputElement
  await act(async () => nextCheckbox.click())
  const nextExpected = container.querySelector(
    '[data-testid="optimization-catalog-task-task-0002"] [aria-label="Expected JSON value"]'
  ) as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      nextExpected,
      '2'
    )
    nextExpected.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Copy current text inputs')
  await click('Preview task stream')
  expect(
    (
      container.querySelector(
        '[aria-label="Shared execution limit (all task assessments and reflections)"]'
      ) as HTMLInputElement
    ).value
  ).toBe('20')
  await click('Preview task stream')
  await click('Start optimization')
  expect(api.startSweep).toHaveBeenCalledWith(
    expect.objectContaining({
      executionLimit: 20,
      catalog: [
        expect.objectContaining({
          taskId: 'task-0001',
          domain: 'csv-count',
          checks: [
            { kind: 'json-value', path: 'result.json', pointer: '', expected: { count: 1 } }
          ],
          source: {
            kind: 'text',
            prompt: 'Task session',
            files: [{ path: 'values.csv', content: 'value\n1' }]
          }
        }),
        {
          taskId: 'task-0002',
          domain: 'csv-count',
          sourceSessionId: 'session',
          source: {
            kind: 'text',
            prompt: 'Count a second data set',
            files: [{ path: 'values.csv', content: 'value\n1' }]
          },
          criteria: 'Second count is correct',
          checks: [{ kind: 'json-value', path: 'result.json', pointer: '', expected: 2 }]
        }
      ]
    })
  )
  await click('Stop optimization')
  expect(api.stop).toHaveBeenCalledWith({
    projectId: 'project',
    sourceSessionId: 'session',
    runId: 'run'
  })
  expect(container.textContent).toContain('Cancelled')
})
it('bounds the catalog to 32 tasks and rejects invalid task, domain and private JSON inputs before preview', async () => {
  await render()
  await input('Acceptance criteria (one per line)', 'criterion')
  for (let index = 1; index <= 31; index++) {
    await click('Add next task')
    await input(`Next task description ${index}`, `Task ${index}`)
    await input(`Next task criteria ${index}`, `Criterion ${index}`)
  }
  const button = (text: string): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find((n) => n.textContent === text)!
  expect(button('Add next task').disabled).toBe(true)
  expect(button('Add Notebook task from another chat').disabled).toBe(true)
  await input('Domain', '../invalid')
  expect(button('Preview task stream').disabled).toBe(true)
  await input('Domain', 'research')
  await input('Recursion parameter (k)', '8')
  await click('Preview task stream')
  expect(button('Start optimization').disabled).toBe(true)
  expect(container.textContent).toContain('Reduce recursion or task count')
  expect(
    (
      container.querySelector(
        '[aria-label="Shared execution limit (all task assessments and reflections)"]'
      ) as HTMLInputElement
    ).value
  ).toBe('512')
  await input('Recursion parameter (k)', '1')
  await click('Preview task stream')
  expect(button('Start optimization').disabled).toBe(false)
  await input('Next task criteria 1', Array(17).fill('criterion').join('\n'))
  expect(button('Preview task stream').disabled).toBe(true)
  expect(button('Start optimization').disabled).toBe(true)
  await input('Next task criteria 1', 'criterion')
  await act(async () =>
    (
      container.querySelector('[aria-label="Check expected JSON output"]') as HTMLInputElement
    ).click()
  )
  await input('Expected JSON value', '{invalid')
  expect(button('Preview task stream').disabled).toBe(true)
  await input('Expected JSON value', '3')
  expect(button('Preview task stream').disabled).toBe(false)
  await input('Output JSON file', '../outside')
  expect(button('Preview task stream').disabled).toBe(true)
  expect(api.start).not.toHaveBeenCalled()
  expect(api.startSweep).not.toHaveBeenCalled()
})
it.each(['blocked', 'unverified'] as const)(
  'shows lifecycle completion independently from %s configuration admission',
  async (status) => {
    vi.mocked(api.latest).mockResolvedValue({
      ...progress('completed'),
      outcome: {
        artifact: { status: status === 'blocked' ? 'failed' : 'unverified', checks: [] },
        configuration: { status, reasons: ['Independent result reason'] }
      }
    })
    await render()
    expect(container.textContent).toContain('Completed')
    expect(container.textContent).toContain(
      status === 'blocked' ? 'Output checks failed' : 'Output checks unverified'
    )
    expect(container.textContent).toContain(
      status === 'blocked'
        ? 'Configuration admission blocked'
        : 'Configuration admission unverified'
    )
    expect(container.textContent).not.toContain('Eligible for further configuration validation')
  }
)
it('shows ordered per-task assessments, output checks and fixed experiment experience provenance', async () => {
  const assessment = {
    executionId: 'r',
    targetExecutionId: 'final1',
    reviewId: 'review1',
    outcome: 'pass' as const,
    score: 91,
    rationale: 'Task evidence matches'
  }
  vi.mocked(api.latest).mockResolvedValue({
    ...progress('completed'),
    domain: {
      name: 'csv-count',
      order: ['task-0001', 'task-0002'],
      tasks: [
        {
          taskId: 'task-0001',
          assessments: { baseline: { ...assessment, score: 80 }, candidate: assessment },
          outcome: {
            artifact: {
              status: 'passed',
              checks: [
                { path: 'result.json', pointer: '/count', status: 'pass', reason: 'matched' }
              ]
            },
            configuration: { status: 'eligible', reasons: [] }
          },
          experience: {
            scope: 'experiment',
            reflectionExecutionId: 'reflect1',
            selectedExecutionId: 'final1',
            selectedHarnessRevisionRef: { id: 'harness1', version: '1', digest: 'sha256:h' },
            reflectionArtifacts: [{ artifactId: 'experience1', versionId: 'v1', checksum: 'sum' }],
            libraryDigest: 'sha256:library'
          }
        }
      ],
      library: { scope: 'experiment', entries: ['task-0001'], digest: 'sha256:library' }
    }
  })
  await render()
  const results = container.querySelector('[data-testid=domain-results]')!
  expect(results.textContent).toContain('Task 1 · task-0001')
  expect(results.textContent).toContain('Task 2 · task-0002')
  expect(results.textContent).toContain('Task result unavailable')
  expect(results.textContent).toContain('Score: 80 · Passed')
  expect(results.textContent).toContain('Score: 91 · Passed')
  expect(results.textContent).toContain('Output check result.json/count: Expected value matched')
  expect(results.textContent).toContain('Recorded experiment experience')
  expect(results.textContent).toContain('Reflection execution: reflect1')
  expect(results.textContent).toContain('Reflection artifact: experience1 · version v1')
  expect(results.textContent).toContain('sha256:library')
  expect(results.textContent).not.toContain('Publish')
})

it.each(['blocked', 'pending'] as const)(
  'keeps a passing first task scoped when the second domain outcome is %s',
  async (second) => {
    const firstOutcome = {
      artifact: { status: 'passed' as const, checks: [] },
      configuration: { status: 'eligible' as const, reasons: [] }
    }
    const blockedOutcome = {
      artifact: { status: 'failed' as const, checks: [] },
      configuration: { status: 'blocked' as const, reasons: ['output-check-failed'] }
    }
    const assessment = {
      executionId: 'r',
      targetExecutionId: 'first-final',
      reviewId: 'review',
      outcome: 'pass' as const,
      score: 90,
      rationale: 'First scoped assessment'
    }
    const assessments = { baseline: { ...assessment, score: 80 }, candidate: assessment }
    vi.mocked(api.latest).mockResolvedValue({
      ...progress(second === 'pending' ? 'cancelled' : 'completed'),
      outcome: firstOutcome,
      assessments,
      domain: {
        name: 'two-tasks',
        order: ['first', 'second'],
        tasks: [
          { taskId: 'first', outcome: firstOutcome, assessments },
          { taskId: 'second', ...(second === 'blocked' ? { outcome: blockedOutcome } : {}) }
        ],
        library: { scope: 'experiment', entries: [], digest: 'digest' }
      }
    })
    await render()
    const results = container.querySelector('[data-testid="domain-results"]')!
    const sections = results.querySelectorAll('section')
    expect(sections[0].textContent).toContain('Eligible for further configuration validation')
    expect(sections[0].textContent).toContain('First scoped assessment')
    expect(sections[1].textContent).toContain(
      second === 'blocked' ? 'Configuration admission blocked' : 'Task result unavailable'
    )
    expect(sections[1].textContent).not.toContain('Eligible for further configuration validation')
    expect(container.querySelectorAll('[data-testid="research-outcome"]')).toHaveLength(
      second === 'blocked' ? 2 : 1
    )
    const outcomes = [...container.querySelectorAll('[data-testid="research-outcome"]')]
    expect(outcomes.every((node) => results.contains(node))).toBe(true)
    expect(
      [...container.querySelectorAll('p')].filter(
        (node) => node.textContent === 'Baseline assessment'
      )
    ).toHaveLength(1)
    expect(container.textContent).not.toContain('output-check-failed')
    if (second === 'blocked')
      expect(sections[1].textContent).toContain('An expected output check failed.')
  }
)
it('explains admission reasons in user-facing language and safely handles newer reason codes', async () => {
  vi.mocked(api.latest).mockResolvedValue({
    ...progress('completed'),
    outcome: {
      artifact: { status: 'unverified', checks: [] },
      configuration: {
        status: 'blocked',
        reasons: [
          'semantic-flagged',
          'output-check-failed',
          'no-deterministic-checks',
          'score-regression',
          'future-internal-reason'
        ]
      }
    }
  })
  await render()
  expect(container.textContent).toContain('Independent assessment flagged the selected result.')
  expect(container.textContent).toContain('An expected output check failed.')
  expect(container.textContent).toContain('No deterministic output checks were supplied.')
  expect(container.textContent).toContain('The candidate scored below the baseline.')
  expect(container.textContent).toContain('Configuration admission needs further review.')
  for (const code of [
    'semantic-flagged',
    'output-check-failed',
    'no-deterministic-checks',
    'score-regression',
    'future-internal-reason'
  ])
    expect(container.textContent).not.toContain(code)
})

it('repeats the original Notebook task by source message identity and disables task editing', async () => {
  await render()
  const checkbox = [...container.querySelectorAll('label')]
    .find((node) => node.textContent?.includes('Repeat this task with Notebook Python'))!
    .querySelector('input')!
  await act(async () => checkbox.click())
  expect(
    (container.querySelector('[aria-label="Task description"]') as HTMLTextAreaElement).disabled
  ).toBe(true)
  expect(container.querySelector('[aria-label="Text input files"]')).toBeNull()
  await input('Acceptance criteria (one per line)', 'Recalculate from fixed source CSV')
  await click('Preview task stream')
  await click('Start optimization')
  expect(api.startSweep).toHaveBeenCalledWith(
    expect.objectContaining({
      catalog: [
        {
          taskId: 'task-0001',
          domain: 'research',
          sourceSessionId: 'session',
          source: { kind: 'notebook', promptMessageId: 'source-prompt' },
          criteria: 'Recalculate from fixed source CSV'
        }
      ]
    })
  )
  expect(api.start).not.toHaveBeenCalled()
  expect(vi.mocked(api.startSweep).mock.calls[0][0].catalog[0].source).not.toHaveProperty(
    'inputArtifacts'
  )
})

it('submits one explicit dual-mode Notebook catalog with a shared budget and source identity', async () => {
  await render()
  const repeat = [...container.querySelectorAll('label')]
    .find((node) => node.textContent?.includes('Repeat this task with Notebook Python'))!
    .querySelector('input')!
  await act(async () => repeat.click())
  await input('Acceptance criteria (one per line)', 'Verify original fixed observations')
  const both = container.querySelector(
    '[aria-label="Compare both optimization modes"]'
  ) as HTMLInputElement
  await act(async () => both.click())
  await click('Preview task stream')
  const limit = container.querySelector(
    '[aria-label="Shared execution limit (all task assessments and reflections)"]'
  ) as HTMLInputElement
  expect(Number(limit.value)).toBe(18)
  expect(limit.max).toBe('512')
  expect(
    (container.querySelector('[aria-label="Optimization mode"]') as HTMLSelectElement).disabled
  ).toBe(true)
  await click('Preview task stream')
  await click('Start optimization')
  expect(api.start).not.toHaveBeenCalled()
  expect(api.startSweep).toHaveBeenCalledExactlyOnceWith({
    projectId: 'project',
    sourceSessionId: 'session',
    requestKey: expect.any(String),
    previewPlanDigest: `sha256:${'a'.repeat(64)}`,
    executionLimit: 18,
    sweep: {
      modes: ['parallel', 'sequential'],
      k: 1,
      concurrency: 1,
      stream: { seed: null, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 1 }
    },
    catalog: [
      {
        taskId: 'task-0001',
        domain: 'research',
        sourceSessionId: 'session',
        source: { kind: 'notebook', promptMessageId: 'source-prompt' },
        criteria: 'Verify original fixed observations'
      }
    ]
  })
})

it('reuses the original result views for both persisted modes and preserves separate outcomes', async () => {
  const outcome = {
    artifact: { status: 'passed' as const, checks: [] },
    configuration: { status: 'eligible' as const, reasons: [] }
  }
  vi.mocked(api.latest).mockResolvedValue({
    ...progress('completed'),
    sweep: {
      planDigest: 'sha256:plan',
      order: [{ domain: 'research', taskIds: ['task'] }],
      modes: ['parallel', 'sequential'],
      domains: [
        {
          mode: 'parallel',
          summary: {
            name: 'research',
            order: ['task'],
            tasks: [{ taskId: 'task', outcome }],
            library: { scope: 'experiment', entries: [], digest: 'sha256:a' }
          }
        },
        {
          mode: 'sequential',
          summary: {
            name: 'research',
            order: ['task'],
            tasks: [
              {
                taskId: 'task',
                outcome: {
                  ...outcome,
                  configuration: { status: 'blocked', reasons: ['score-regression'] }
                }
              }
            ],
            library: { scope: 'experiment', entries: [], digest: 'sha256:s' }
          }
        }
      ]
    }
  })
  await render()
  const results = [...container.querySelectorAll('[data-testid="domain-results"]')]
  expect(results).toHaveLength(2)
  expect(results[0].textContent).toContain('Parallel')
  expect(results[1].textContent).toContain('Sequential')
  expect(results[0].textContent).toContain('Output checks passed')
  expect(results[1].textContent).toContain('The candidate scored below the baseline.')
})

const selectSource = async (scope: Element, label: string, value: string): Promise<void> => {
  const node = scope.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const button = (text: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((n) => n.textContent === text)!
it('starts two independently chosen original Notebook sources with separate criteria and no inherited inputs', async () => {
  await render()
  await act(async () =>
    (
      container.querySelector(
        '[data-testid="optimization-catalog-task-task-0001"] input[type=checkbox]'
      ) as HTMLInputElement
    ).click()
  )
  await input('Acceptance criteria (one per line)', 'Verify first observations')
  await click('Add Notebook task from another chat')
  const other = container.querySelector('[data-testid="optimization-catalog-task-task-0002"]')!
  await selectSource(other, 'Source chat', 'another')
  await selectSource(other, 'Source task', 'other-prompt')
  await input('Next task criteria 1', 'Verify second observations')
  await click('Preview task stream')
  expect(api.previewSweep).toHaveBeenCalledExactlyOnceWith({
    projectId: 'project',
    sourceSessionId: 'session',
    catalog: [
      { taskId: 'task-0001', domain: 'research' },
      { taskId: 'task-0002', domain: 'research' }
    ],
    sweep: {
      modes: ['sequential'],
      k: 1,
      concurrency: 1,
      stream: { seed: null, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 1 }
    }
  })
  expect(JSON.stringify(vi.mocked(api.previewSweep).mock.calls)).not.toContain('observations')
  await click('Start optimization')
  expect(api.startSweep).toHaveBeenCalledWith(
    expect.objectContaining({
      catalog: [
        {
          taskId: 'task-0001',
          domain: 'research',
          sourceSessionId: 'session',
          source: { kind: 'notebook', promptMessageId: 'source-prompt' },
          criteria: 'Verify first observations'
        },
        {
          taskId: 'task-0002',
          domain: 'research',
          sourceSessionId: 'another',
          source: { kind: 'notebook', promptMessageId: 'other-prompt' },
          criteria: 'Verify second observations'
        }
      ]
    })
  )
  expect(sessions.loadOne).toHaveBeenCalledWith({ projectId: 'project', sessionId: 'another' })
})
it.each([
  ['', null],
  ['0', 0],
  ['-7', -7]
] as const)(
  'passes seed %s and filters unchanged and shows only original preview order',
  async (value, seed) => {
    await render()
    await input('Acceptance criteria (one per line)', 'criterion')
    await input('Shuffle seed (empty uses original order)', value)
    await input('Domain filter', 'research other')
    await input('Task filter', 'task-0001')
    await input('Tasks per domain (empty means all)', '2')
    await input('Domain workers', '3')
    vi.mocked(api.previewSweep).mockResolvedValue({
      planDigest: 'sha256:original',
      modes: ['sequential'],
      order: [{ domain: 'original-order', taskIds: ['original-task'] }],
      minimumExecutions: 24
    })
    expect(button('Start optimization').disabled).toBe(true)
    await click('Preview task stream')
    expect(api.previewSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        sweep: expect.objectContaining({
          stream: {
            seed,
            onlyDomains: ['research', 'other'],
            onlyTasks: ['task-0001'],
            maxTasks: 2,
            workers: 3
          }
        })
      })
    )
    expect(
      container.querySelector('[data-testid="optimization-sweep-preview"]')!.textContent
    ).toContain('Planned domain original-order: original-task')
    expect(container.textContent).toContain('First attempts require 24 executions')
    expect(button('Start optimization').disabled).toBe(false)
  }
)
it.each(['edit', 'switch', 'revert'] as const)(
  'discards in-flight preview after %s and never enables Start from its stale minimum',
  async (change) => {
    let finish!: (value: Awaited<ReturnType<DesktopOptimizationApi['previewSweep']>>) => void
    vi.mocked(api.previewSweep).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    await render()
    await input('Acceptance criteria (one per line)', 'criterion')
    await click('Preview task stream')
    if (change === 'switch') await render('another')
    else {
      await input('Task description', 'Changed')
      if (change === 'revert') await input('Task description', 'Task session')
    }
    await act(async () =>
      finish({
        planDigest: 'sha256:stale',
        modes: ['sequential'],
        order: [{ domain: 'stale', taskIds: ['wrong'] }],
        minimumExecutions: 1
      })
    )
    expect(container.querySelector('[data-testid="optimization-sweep-preview"]')).toBeNull()
    expect(button('Start optimization').disabled).toBe(true)
    expect(api.startSweep).not.toHaveBeenCalled()
  }
)
it('retains a failed submission key only for exactly the same request and gets a new key after edits', async () => {
  vi.mocked(api.startSweep).mockRejectedValue(new Error('synthetic-private-provider-secret'))
  await render()
  await input('Acceptance criteria (one per line)', 'criterion')
  await click('Preview task stream')
  await click('Start optimization')
  await click('Start optimization')
  const first = vi.mocked(api.startSweep).mock.calls[0][0],
    retry = vi.mocked(api.startSweep).mock.calls[1][0]
  expect(retry.requestKey).toBe(first.requestKey)
  await input('Acceptance criteria (one per line)', 'Changed criterion')
  expect(button('Start optimization').disabled).toBe(true)
  await click('Preview task stream')
  await click('Start optimization')
  const changed = vi.mocked(api.startSweep).mock.calls[2][0]
  expect(changed.requestKey).not.toBe(first.requestKey)
  expect(changed.catalog[0].criteria).toBe('Changed criterion')
  expect(container.textContent).not.toContain('synthetic-private-provider-secret')
})
it('requires every catalog source to be structurally ready even when a filter would exclude it', async () => {
  await render()
  await input('Acceptance criteria (one per line)', 'criterion')
  await click('Add Notebook task from another chat')
  await input('Next task criteria 1', 'Other criterion')
  await input('Task filter', 'task-0001')
  expect(button('Preview task stream').disabled).toBe(true)
  expect(api.previewSweep).not.toHaveBeenCalled()
})
it('never shares current text inputs with another task unless explicitly copied', async () => {
  await render()
  await input('Acceptance criteria (one per line)', 'criterion')
  await click('Add next task')
  await input('Next task description 1', 'Other')
  await input('Next task criteria 1', 'Other criterion')
  const primary = container.querySelector('[data-testid="optimization-catalog-task-task-0001"]')!
  const file = new File(['value\n2'], 'values.csv')
  Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue('value\n2') })
  await act(async () => {
    const control = primary.querySelector('input[type=file]')!
    Object.defineProperty(control, 'files', { configurable: true, value: [file] })
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click('Preview task stream')
  await click('Start optimization')
  const catalog = vi.mocked(api.startSweep).mock.calls[0][0].catalog
  expect(catalog[0].source).toMatchObject({ files: [{ path: 'values.csv', content: 'value\n2' }] })
  expect(catalog[1].source).toEqual({ kind: 'text', prompt: 'Other', files: [] })
  expect(catalog[1].criteria).toBe('Other criterion')
})

it('ignores an old source snapshot after choosing a different source chat', async () => {
  let old!: (value: PersistedChatSession) => void
  vi.mocked(sessions.loadOne)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        old = resolve
      })
    )
    .mockResolvedValueOnce(sourceSession('another', 'other-prompt'))
  await render()
  await act(async () =>
    (
      container.querySelector(
        '[data-testid="optimization-catalog-task-task-0001"] input[type=checkbox]'
      ) as HTMLInputElement
    ).click()
  )
  const primary = container.querySelector('[data-testid="optimization-catalog-task-task-0001"]')!
  await selectSource(primary, 'Source chat', 'another')
  await selectSource(primary, 'Source task', 'other-prompt')
  await act(async () => old(sourceSession()))
  expect((primary.querySelector('[aria-label="Source task"]') as HTMLSelectElement).value).toBe(
    'other-prompt'
  )
  await input('Acceptance criteria (one per line)', 'Own second source')
  await click('Preview task stream')
  await click('Start optimization')
  expect(vi.mocked(api.startSweep).mock.calls[0][0].catalog[0]).toMatchObject({
    sourceSessionId: 'another',
    source: { kind: 'notebook', promptMessageId: 'other-prompt' }
  })
})
it.each(['foreign', 'archived', 'package'] as const)(
  'rejects a loaded %s source snapshot and exposes no raw source error',
  async (kind) => {
    const source = sourceSession()
    if (kind === 'foreign') source.projectId = 'other'
    if (kind === 'archived') source.archivedAt = 1
    if (kind === 'package')
      source.packageOrigin = {} as NonNullable<PersistedChatSession['packageOrigin']>
    vi.mocked(sessions.loadOne).mockResolvedValue(source)
    await render()
    await act(async () =>
      (
        container.querySelector(
          '[data-testid="optimization-catalog-task-task-0001"] input[type=checkbox]'
        ) as HTMLInputElement
      ).click()
    )
    await input('Acceptance criteria (one per line)', 'criterion')
    expect(button('Preview task stream').disabled).toBe(true)
    expect(container.textContent).toContain('Source chat could not be loaded.')
    expect(api.previewSweep).not.toHaveBeenCalled()
  }
)
it.each([true, false])(
  'keeps per-task selector narrative, trivial=%s and fallback visible in v2 results',
  async (trivial) => {
    vi.mocked(api.latest).mockResolvedValue({
      ...progress('completed'),
      sweep: {
        planDigest: 'sha256:plan',
        modes: ['sequential'],
        order: [{ domain: 'research', taskIds: ['task-0001'] }],
        domains: [
          {
            mode: 'sequential',
            summary: {
              name: 'research',
              order: ['task-0001'],
              tasks: [
                {
                  taskId: 'task-0001',
                  selection: {
                    chosenLabel: 'final2',
                    candidateCount: 2,
                    trivial,
                    fallback: true,
                    reason: 'Original selection explanation'
                  }
                }
              ],
              library: { scope: 'experiment', entries: [], digest: 'sha256:library' }
            }
          }
        ]
      }
    })
    await render()
    const results = container.querySelector('[data-testid="domain-results"]')!
    expect(results.textContent).toContain('Selected final2 from 2 candidates')
    expect(results.textContent).toContain(trivial ? 'Trivial selection' : 'Selector comparison')
    expect(results.textContent).toContain('Selection fallback')
    expect(results.textContent).toContain('Original selection explanation')
  }
)
