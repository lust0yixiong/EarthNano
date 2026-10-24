import { describe, expect, it, vi } from 'vitest'
import {
  createLogoParticles,
  drawEarthNanoLogoFrame,
  LOGO_INTRO_DURATION_MS,
  resolveLogoFrame,
  resolveLogoParticlePosition,
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
        wordmarkOpacity: 1
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
  it('lands on the unchanged logo before crossfading at different pixel densities and sizes', () => {
    for (const dpr of [1, 2]) {
      for (const size of [116, 174]) {
        const metrics = { width: 448 * dpr, height: 224 * dpr, dpr, markSize: size * dpr }
        const particles = createLogoParticles(metrics)
        for (const particle of particles) {
          for (const progress of [0.66, 0.75, 0.88]) {
            const position = resolveLogoParticlePosition(particle, metrics, progress)
            expect(position.x).toBeCloseTo(metrics.width / 2 + particle.targetX, 8)
            expect(position.y).toBeCloseTo(metrics.height / 2 + particle.targetY, 8)
          }
        }
      }
    }
    expect(resolveLogoPresentation({ mode: 'gather', progress: 0.66 }).imageOpacity).toBe(0)
    expect(
      resolveLogoPresentation({ mode: 'gather', progress: 0.75 }).imageOpacity
    ).toBeGreaterThan(0)
    expect(resolveLogoPresentation({ mode: 'gather', progress: 0.88 }).imageOpacity).toBe(1)
  })
  it('keeps the circular entrance inside the canvas at desktop and narrow widths', () => {
    for (const width of [320, 448]) {
      const metrics = { width, height: 224, dpr: 1 }
      for (const particle of createLogoParticles(metrics)) {
        for (const progress of [0, 0.1, 0.3, 0.5, 0.66]) {
          const { x, y } = resolveLogoParticlePosition(particle, metrics, progress)
          expect(x).toBeGreaterThan(particle.radius)
          expect(x).toBeLessThan(width - particle.radius)
          expect(y).toBeGreaterThan(particle.radius)
          expect(y).toBeLessThan(metrics.height - particle.radius)
        }
      }
    }
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
