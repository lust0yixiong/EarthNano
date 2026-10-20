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
  budget: { limit: 9, admitted: 1, completed: 0, active: 1 },
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
  expect(container.textContent).toContain('Used 1 of 9 executions')
  await click('Stop optimization')
  expect(api.stop).toHaveBeenCalledWith({
    projectId: 'project',
    sourceSessionId: 'session',
    runId: 'run'
  })
  expect(container.textContent).toContain('Cancelled')
})
it('requires 1–16 criteria and a 9–20 budget, and shows safe errors', async () => {
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
  expect(container.textContent).not.toContain('Used 1 of 9')
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
