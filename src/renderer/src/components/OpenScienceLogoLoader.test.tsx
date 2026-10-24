// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenScienceLogoLoader } from './OpenScienceLogoLoader'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TestQuery = {
  matches: boolean
  listeners: Set<(event: MediaQueryListEvent) => void>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}
const query = (matches = false): TestQuery => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  return {
    matches,
    listeners,
    addEventListener: vi.fn((_type: string, fn: (event: MediaQueryListEvent) => void) =>
      listeners.add(fn)
    ),
    removeEventListener: vi.fn((_type: string, fn: (event: MediaQueryListEvent) => void) =>
      listeners.delete(fn)
    )
  }
}

describe('EarthNano loader through existing upstream entry point', () => {
  let container: HTMLDivElement, root: Root, now: number, width: number
  let frames: Map<number, FrameRequestCallback>, nextId: number
  let motion: ReturnType<typeof query>, resolutions: ReturnType<typeof query>[]
  let resize: ResizeObserverCallback | undefined
  let disconnect: ReturnType<typeof vi.fn>
  let context: CanvasRenderingContext2D
  let ratio: PropertyDescriptor | undefined
  const frameAt = (time: number): void => {
    now = time
    const entry = frames.entries().next().value
    if (entry) {
      frames.delete(entry[0])
      act(() => entry[1](now))
    }
  }
  const image = (): HTMLImageElement => container.querySelector('img')!
  const mount = (): void => {
    act(() => root.render(<OpenScienceLogoLoader />))
  }
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    now = 0
    width = 448
    frames = new Map()
    nextId = 1
    motion = query()
    resolutions = []
    disconnect = vi.fn()
    ratio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    context = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fill: vi.fn(),
      save: vi.fn(),
      restore: vi.fn()
    } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 224,
      right: width,
      width,
      height: 224,
      toJSON: () => undefined
    }))
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      const id = nextId++
      frames.set(id, fn)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    vi.stubGlobal(
      'matchMedia',
      vi.fn((value: string) => {
        if (value.includes('prefers-reduced-motion')) return motion as unknown as MediaQueryList
        const q = query()
        resolutions.push(q)
        return q as unknown as MediaQueryList
      })
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(fn: ResizeObserverCallback) {
          resize = fn
        }
        observe = vi.fn()
        disconnect = disconnect
      }
    )
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (ratio) Object.defineProperty(window, 'devicePixelRatio', ratio)
  })
  it('uses color particles, settles once, and never restarts when startup gates remount', () => {
    mount()
    expect(frames.size).toBe(1)
    frameAt(1000)
    expect(context.arc).toHaveBeenCalled()
    frameAt(3300)
    expect(image().style.opacity).toBe('1')
    expect(container.textContent).toContain('EarthNano')
    expect(frames.size).toBe(0)
    act(() => root.render(null))
    now = 10_000
    mount()
    expect(image().style.opacity).toBe('1')
    expect(frames.size).toBe(0)
  })
  it('supports live reduced-motion changes without restarting the entrance', () => {
    mount()
    now = 500
    motion.matches = true
    act(() => {
      for (const fn of motion.listeners) fn({ matches: true } as MediaQueryListEvent)
    })
    expect(frames.size).toBe(0)
    expect(image().style.opacity).toBe('1')
    const arcs = vi.mocked(context.arc).mock.calls.length
    now = 5000
    motion.matches = false
    act(() => {
      for (const fn of motion.listeners) fn({ matches: false } as MediaQueryListEvent)
    })
    expect(frames.size).toBe(0)
    expect(vi.mocked(context.arc)).toHaveBeenCalledTimes(arcs)
    expect(image().style.opacity).toBe('1')
  })
  it('lets the startup owner unmount during the entrance without waiting for the animation', () => {
    mount()
    frameAt(500)
    expect(image().style.opacity).toBe('0')
    expect(frames.size).toBe(1)
    act(() => root.render(null))
    expect(container.childElementCount).toBe(0)
    expect(frames.size).toBe(0)
    expect(disconnect).toHaveBeenCalledOnce()
  })
  it('caps frame rate and DPR, resizes, pauses hidden pages and releases all subscriptions', () => {
    mount()
    const canvas = container.querySelector('canvas')!
    expect(canvas.width).toBe(448)
    frameAt(1000)
    const draws = vi.mocked(context.clearRect).mock.calls.length
    frameAt(1010)
    expect(context.clearRect).toHaveBeenCalledTimes(draws)
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 4 })
    act(() => {
      for (const fn of resolutions[0].listeners) fn({ matches: false } as MediaQueryListEvent)
    })
    expect(canvas.width).toBe(896)
    expect(canvas.height).toBe(448)
    expect(resolutions[0].listeners.size).toBe(0)
    width = 320
    act(() => resize?.([], {} as ResizeObserver))
    expect(canvas.width).toBe(640)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(frames.size).toBe(0)
    now = 5000
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(frames.size).toBe(0)
    expect(image().style.opacity).toBe('1')
    act(() => root.render(null))
    expect(disconnect).toHaveBeenCalledOnce()
    expect(motion.listeners.size).toBe(0)
    expect(resolutions.at(-1)?.listeners.size).toBe(0)
  })
  it('keeps a static image and wordmark when Canvas is unavailable', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    mount()
    expect(image().getAttribute('src')).toContain('logo.png')
    expect(image().style.opacity).not.toBe('0')
    expect(container.textContent).toContain('EarthNano')
    expect(frames.size).toBe(0)
  })
  it('tracks the rendered mark size without shifting it during the particle handoff', () => {
    let imageWidth = 116
    vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: imageWidth,
      bottom: imageWidth,
      width: imageWidth,
      height: imageWidth,
      toJSON: () => undefined
    }))
    mount()
    frameAt(2200)
    const before = vi.mocked(context.arc).mock.calls.at(-1)!
    imageWidth = 174
    act(() => resize?.([], {} as ResizeObserver))
    const after = vi.mocked(context.arc).mock.calls.at(-1)!
    expect(after[0] - 224).toBeCloseTo((before[0] - 224) * 1.5)
    expect(after[1] - 112).toBeCloseTo((before[1] - 112) * 1.5)
    expect(image().style.transform).toBe('')
  })
})
