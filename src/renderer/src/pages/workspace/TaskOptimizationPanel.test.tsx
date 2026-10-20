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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key.replace(/{{(.*?)}}/g, (_all, name) => String(values?.[name] ?? ''))
  })
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root, api: DesktopOptimizationApi
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
const render = async (sessionId = 'session'): Promise<void> => {
  await act(async () =>
    root.render(
      <TaskOptimizationPanel
        projectId="project"
        sessionId={sessionId}
        initialPrompt={`Task ${sessionId}`}
        api={api}
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
beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  api = {
    start: vi.fn().mockResolvedValue(progress()),
    get: vi.fn().mockResolvedValue(progress()),
    latest: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(progress('cancelled'))
  }
})
afterEach(async () => {
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
  await click('Start optimization')
  expect(api.start).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'project',
      sourceSessionId: 'session',
      prompt: 'Edited task',
      executionLimit: 12,
      files: [],
      criteria: 'Output is valid JSON\nThe answer equals 42',
      requestKey: expect.any(String)
    })
  )
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
  vi.mocked(api.start).mockRejectedValue(new Error('synthetic-provider-secret'))
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
  vi.mocked(api.start).mockResolvedValue({ ...progress(), runId: 'next-run' })
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
    expect(executionLimit.value).toBe('17')
    expect(executionLimit.max).toBe('128')
    expect(container.textContent).toContain('First attempts require 17 executions')
    await input('Execution limit (includes two assessments)', '16')
    await click('Start optimization')
    expect(api.start).not.toHaveBeenCalled()
    await input('Execution limit (includes two assessments)', '20')
    await click('Start optimization')
    expect(api.start).toHaveBeenCalledWith(
      expect.objectContaining({ method: { mode, k: 2, concurrency: 3 }, executionLimit: 20 })
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
  await input('Domain experiment name (optional)', 'csv-count')
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
    '[data-testid="next-task-1"] [aria-label="Check expected JSON output"]'
  ) as HTMLInputElement
  await act(async () => nextCheckbox.click())
  const nextExpected = container.querySelector(
    '[data-testid="next-task-1"] [aria-label="Expected JSON value"]'
  ) as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      nextExpected,
      '2'
    )
    nextExpected.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(
    (
      container.querySelector(
        '[aria-label="Shared execution limit (all task assessments and reflections)"]'
      ) as HTMLInputElement
    ).value
  ).toBe('20')
  await click('Start optimization')
  expect(api.start).toHaveBeenCalledWith(
    expect.objectContaining({
      checks: [{ kind: 'json-value', path: 'result.json', pointer: '', expected: { count: 1 } }],
      executionLimit: 20,
      domain: {
        name: 'csv-count',
        nextTasks: [
          {
            prompt: 'Count a second data set',
            criteria: 'Second count is correct',
            files: [{ path: 'values.csv', content: 'value\n1' }],
            checks: [{ kind: 'json-value', path: 'result.json', pointer: '', expected: 2 }]
          }
        ]
      }
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
it('bounds the stream to four tasks and requires valid task, domain and private JSON inputs', async () => {
  await render()
  await input('Acceptance criteria (one per line)', 'criterion')
  for (let index = 1; index <= 3; index++) {
    await click('Add next task')
    await input(`Next task description ${index}`, `Task ${index}`)
    await input(`Next task criteria ${index}`, `Criterion ${index}`)
  }
  const add = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === 'Add next task'
  )!
  expect(add.disabled).toBe(true)
  const start = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === 'Start optimization'
  )!
  expect(start.disabled).toBe(true)
  await input('Domain experiment name (optional)', 'four-tasks')
  expect(start.disabled).toBe(false)
  await input('Recursion parameter (k)', '8')
  expect(start.disabled).toBe(true)
  expect(container.textContent).toContain('Reduce recursion or task count')
  expect(
    (
      container.querySelector(
        '[aria-label="Shared execution limit (all task assessments and reflections)"]'
      ) as HTMLInputElement
    ).value
  ).toBe('128')
  await input('Recursion parameter (k)', '2')
  expect(start.disabled).toBe(false)
  await input('Next task criteria 1', Array(17).fill('criterion').join('\n'))
  expect(start.disabled).toBe(true)
  await input('Next task criteria 1', 'criterion')
  expect(start.disabled).toBe(false)
  await act(async () =>
    (
      container.querySelector('[aria-label="Check expected JSON output"]') as HTMLInputElement
    ).click()
  )
  await input('Expected JSON value', '{invalid')
  expect(start.disabled).toBe(true)
  await input('Expected JSON value', '3')
  expect(start.disabled).toBe(false)
  await input('Output JSON file', '../outside')
  expect(start.disabled).toBe(true)
  expect(api.start).not.toHaveBeenCalled()
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
