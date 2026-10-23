import { describe, expect, it, vi } from 'vitest'
import {
  createLogoParticles,
  drawEarthNanoLogoFrame,
  LOGO_INTRO_DURATION_MS,
  resolveLogoFrame,
  resolveLogoPresentation
} from './earthnano-logo-motion'

describe('EarthNano vortex entrance', () => {
  it('gathers once and keeps the complete mark after arbitrarily long startup waits', () => {
    expect(resolveLogoFrame(0).mode).toBe('gather')
    expect(resolveLogoFrame(1000).progress).toBeGreaterThan(0)
    for (const time of [LOGO_INTRO_DURATION_MS, 6400, 600_000]) {
      const frame = resolveLogoFrame(time)
      expect(frame).toEqual({ mode: 'hold', progress: 1 })
      expect(resolveLogoPresentation(frame)).toEqual({
        imageOpacity: 1,
        wordmarkOpacity: 1,
        settle: 1
      })
    }
    expect(resolveLogoFrame(-100).progress).toBe(0)
    expect(resolveLogoFrame(5000, 0).mode).toBe('hold')
  })
  it('immediately presents the complete brand with reduced motion', () => {
    expect(resolveLogoFrame(0, 3200, true)).toEqual({ mode: 'hold', progress: 1 })
  })
  it('has bounded deterministic particles in the actual blue-green artwork colors', () => {
    const metrics = { width: 896, height: 448, dpr: 2 }
    const particles = createLogoParticles(metrics, 42)
    expect(particles.length).toBeGreaterThan(200)
    expect(particles.length).toBeLessThan(600)
    expect(createLogoParticles(metrics, 42)).toEqual(particles)
    expect(createLogoParticles(metrics, 43)).not.toEqual(particles)
    expect(new Set(particles.map((p) => p.color)).size).toBeGreaterThan(20)
    expect(particles.every((p) => Math.abs(p.targetX) <= 116 && Math.abs(p.targetY) <= 116)).toBe(
      true
    )
  })
  it('clears the particle canvas and draws nothing in the settled state', () => {
    const context = {
      clearRect: vi.fn(),
      arc: vi.fn(),
      save: vi.fn(),
      restore: vi.fn()
    } as unknown as CanvasRenderingContext2D
    const metrics = { width: 448, height: 224, dpr: 1 }
    drawEarthNanoLogoFrame(
      context,
      createLogoParticles(metrics),
      metrics,
      resolveLogoFrame(100_000)
    )
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 448, 224)
    expect(context.arc).not.toHaveBeenCalled()
  })
})
