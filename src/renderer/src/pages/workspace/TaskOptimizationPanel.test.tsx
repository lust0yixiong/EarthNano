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
