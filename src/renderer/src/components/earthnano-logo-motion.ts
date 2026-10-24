import { EARTHNANO_LOGO_POINTS } from './earthnano-logo-points'

export const LOGO_INTRO_DURATION_MS = 3200
export type LogoMotionFrame = { mode: 'gather' | 'hold'; progress: number }
export type LogoCanvasMetrics = {
  width: number
  height: number
  dpr: number
  markSize?: number
}
export type LogoParticle = {
  targetX: number
  targetY: number
  angle: number
  spread: number
  radius: number
  delay: number
  alpha: number
  color: string
}
const clamp = (n: number): number => Math.max(0, Math.min(1, n))
const smooth = (n: number): number => {
  const t = clamp(n)
  return t * t * (3 - 2 * t)
}
const markSize = (metrics: LogoCanvasMetrics): number =>
  metrics.markSize ?? Math.min(116 * metrics.dpr, Math.min(metrics.width, metrics.height) * 0.66)
// The approved SVG's body circle is at (620, 650) inside viewBox="80 90 1120 1120".
// Its center sits slightly left of the square canvas, leaving room for the outward droplets.
const vortexCenterX = (metrics: LogoCanvasMetrics): number => -markSize(metrics) / 56
const randomSource = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}
// An entrance, not a looping spinner. Real startup owners may unmount it at any time.
export const resolveLogoFrame = (
  time: number,
  duration = LOGO_INTRO_DURATION_MS,
  prefersReducedMotion = false
): LogoMotionFrame => {
  const progress = prefersReducedMotion
    ? 1
    : clamp(time / (duration > 0 ? duration : LOGO_INTRO_DURATION_MS))
  return { mode: progress >= 1 ? 'hold' : 'gather', progress }
}
export const resolveLogoPresentation = (
  frame: LogoMotionFrame
): { imageOpacity: number; wordmarkOpacity: number } => ({
  // Every particle has reached its sampled position before the complete mark fades in.
  imageOpacity: frame.mode === 'hold' ? 1 : smooth((frame.progress - 0.66) / 0.22),
  wordmarkOpacity: frame.mode === 'hold' ? 1 : smooth((frame.progress - 0.44) / 0.31)
})
export const createLogoParticles = (
  metrics: LogoCanvasMetrics,
  seed = 0x5c1e4ce
): LogoParticle[] => {
  const random = randomSource(seed)
  const size = markSize(metrics)
  const centerX = vortexCenterX(metrics)
  return EARTHNANO_LOGO_POINTS.map(([x, y, r, g, b]) => {
    const targetX = (x / 96 - 0.5) * size
    const targetY = (y / 96 - 0.5) * size
    const distance = Math.hypot(targetX - centerX, targetY)
    return {
      targetX,
      targetY,
      angle: Math.atan2(targetY, targetX - centerX),
      spread: 0.65 + random() * 0.35,
      radius: (0.6 + random() * 0.5) * metrics.dpr,
      delay: random() * 0.04 + Math.min(1, distance / (size * 0.44)) * 0.06,
      alpha: 0.55 + random() * 0.4,
      color: `rgb(${r}, ${g}, ${b})`
    }
  })
}
export const resolveLogoParticlePosition = (
  particle: LogoParticle,
  metrics: LogoCanvasMetrics,
  progress: number
): { x: number; y: number; local: number } => {
  const local = smooth((progress - particle.delay) / 0.56)
  const centerX = vortexCenterX(metrics)
  const targetRadius = Math.hypot(particle.targetX - centerX, particle.targetY)
  const outerRadius = Math.max(
    targetRadius,
    Math.min(metrics.width, metrics.height) * 0.46 * particle.spread
  )
  const radius = targetRadius + (outerRadius - targetRadius) * (1 - local)
  const angle = particle.angle - (1 - local) * 1.7
  return {
    x: metrics.width / 2 + centerX + Math.cos(angle) * radius,
    y: metrics.height / 2 + Math.sin(angle) * radius,
    local
  }
}
export const drawEarthNanoLogoFrame = (
  context: CanvasRenderingContext2D,
  particles: readonly LogoParticle[],
  metrics: LogoCanvasMetrics,
  frame: LogoMotionFrame
): void => {
  context.clearRect(0, 0, metrics.width, metrics.height)
  if (frame.mode === 'hold') return
  const reveal = resolveLogoPresentation(frame).imageOpacity
  context.save()
  for (const particle of particles) {
    const { x, y, local } = resolveLogoParticlePosition(particle, metrics, frame.progress)
    context.globalAlpha = smooth(frame.progress / 0.1) * (1 - reveal) * particle.alpha
    context.fillStyle = particle.color
    context.beginPath()
    context.arc(
      x,
      y,
      Math.max(0.65 * metrics.dpr, particle.radius * (1 - local) + 0.85 * metrics.dpr * local),
      0,
      Math.PI * 2
    )
    context.fill()
  }
  context.restore()
}
