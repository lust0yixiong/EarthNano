import { EARTHNANO_LOGO_POINTS } from './earthnano-logo-points'

export const LOGO_INTRO_DURATION_MS = 3200
export type LogoMotionFrame = { mode: 'gather' | 'hold'; progress: number }
export type LogoCanvasMetrics = { width: number; height: number; dpr: number }
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
): { imageOpacity: number; wordmarkOpacity: number; settle: number } => ({
  imageOpacity: frame.mode === 'hold' ? 1 : smooth((frame.progress - 0.48) / 0.27),
  wordmarkOpacity:
    frame.mode === 'hold' ? 1 : 1 - Math.pow(1 - clamp((frame.progress - 0.35) / 0.35), 3),
  settle: frame.mode === 'hold' ? 1 : smooth((frame.progress - 0.18) / 0.53)
})
export const createLogoParticles = (
  metrics: LogoCanvasMetrics,
  seed = 0x5c1e4ce
): LogoParticle[] => {
  const random = randomSource(seed)
  const size = Math.min(116 * metrics.dpr, Math.min(metrics.width, metrics.height) * 0.66)
  return EARTHNANO_LOGO_POINTS.map(([x, y, r, g, b], index) => ({
    targetX: (x / 96 - 0.5) * size,
    targetY: (y / 96 - 0.5) * size,
    angle: index * 2.399963,
    spread: 0.5 + random() * 0.5,
    radius: (0.6 + random() * 0.7) * metrics.dpr,
    delay: random() * 0.12,
    alpha: 0.45 + random() * 0.5,
    color: `rgb(${r}, ${g}, ${b})`
  }))
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
  const spread = Math.min(metrics.width * 0.43, 236 * metrics.dpr)
  context.save()
  for (const particle of particles) {
    const local = smooth((frame.progress - particle.delay) / 0.7)
    const angle = particle.angle + (1 - local) * 1.35
    const x =
      metrics.width / 2 +
      Math.cos(angle) * spread * particle.spread * (1 - local) +
      particle.targetX * local
    const y =
      metrics.height / 2 +
      Math.sin(angle) * 100 * metrics.dpr * particle.spread * (1 - local) +
      particle.targetY * local
    context.globalAlpha =
      (0.32 + 0.68 * smooth(frame.progress / 0.14)) * (1 - reveal) * particle.alpha
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
