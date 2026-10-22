// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { UpstreamTrialExamples } from './UpstreamTrialExamples'
import { upstreamTrialFiles, upstreamTrials } from '@/lib/upstream-trials'

let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it('stages a selected original case only through the supplied composer action', () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const onSelect = vi.fn()
  act(() => root!.render(<UpstreamTrialExamples onSelect={onSelect} />))
  expect(onSelect).not.toHaveBeenCalled()
  for (const id of ['openscience-case16', 'harness2-ledger'] as const) {
    act(() => container!.querySelector<HTMLButtonElement>(`[data-testid="trial-${id}"]`)!.click())
    expect(onSelect).toHaveBeenLastCalledWith(id)
  }
  expect(onSelect).toHaveBeenCalledTimes(2)
  const links = container.querySelectorAll<HTMLAnchorElement>('a')
  expect([...links].map((link) => link.href)).toEqual([
    upstreamTrials['openscience-case16'].source,
    upstreamTrials['harness2-ledger'].source
  ])
})

it('disables both examples when the original composer cannot accept a fresh case', () => {
  container = document.createElement('div')
  root = createRoot(container)
  act(() => root!.render(<UpstreamTrialExamples />))
  expect([...container.querySelectorAll('button')].every((button) => button.disabled)).toBe(true)
})

it('attaches source inputs without supplying held-out reference outputs to the agent', () => {
  const case16 = upstreamTrialFiles('openscience-case16')
  expect(case16.map((file) => [file.name, file.size])).toEqual([
    ['analysis.py', 8249],
    ['registry_source.json', 1669267]
  ])
  expect(upstreamTrialFiles('harness2-ledger').map((file) => file.name)).toEqual([
    'ledger-1.csv',
    'ledger-2.csv'
  ])
  expect(upstreamTrials['harness2-ledger'].prompt).not.toContain('85.15')
  expect(upstreamTrials['openscience-case16'].prompt).not.toContain('41.25')
})
