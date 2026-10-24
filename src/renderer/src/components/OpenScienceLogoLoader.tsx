import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import logoUrl from '@/assets/logo.png'
import { AppWordmark } from './AppWordmark'
import {
  createLogoParticles,
  drawEarthNanoLogoFrame,
  LOGO_INTRO_DURATION_MS,
  resolveLogoFrame,
  resolveLogoPresentation,
  type LogoCanvasMetrics,
  type LogoParticle
} from './earthnano-logo-motion'

const MIN_FRAME_INTERVAL_MS = 1000 / 30
const MAX_DEVICE_PIXEL_RATIO = 2
// Shared across startup gate remounts; completing hydration never waits for this timeline.
let animationStartedAt: number | undefined

const EarthNanoLogoLoader = (): React.JSX.Element => {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const wordmarkRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    const image = imageRef.current
    const wordmark = wordmarkRef.current
    // The regular image and wordmark remain visible before effects, including without Canvas.
    if (!canvas || !context || !image || !wordmark) return
    const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let resolutionQuery: MediaQueryList | undefined
    let reducedMotion = motionQuery?.matches ?? false
    let animationFrame: number | undefined
    let lastDrawnAt: number | undefined
    let metrics: LogoCanvasMetrics = { width: 1, height: 1, dpr: 1 }
    let particles: LogoParticle[] = []
    animationStartedAt ??= performance.now()
    const elapsed = (now: number): number => Math.max(0, now - animationStartedAt!)
    const draw = (time: number): void => {
      const frame = resolveLogoFrame(time, LOGO_INTRO_DURATION_MS, reducedMotion)
      drawEarthNanoLogoFrame(context, particles, metrics, frame)
      const presentation = resolveLogoPresentation(frame)
      image.style.opacity = String(presentation.imageOpacity)
      // Keep the image on the same coordinates as the settled particles throughout the handoff.
      wordmark.style.opacity = String(presentation.wordmarkOpacity)
      wordmark.style.transform = `translateY(${7 * (1 - presentation.wordmarkOpacity)}px)`
    }
    const animate = (now: number): void => {
      animationFrame = undefined
      const time = elapsed(now)
      if (
        lastDrawnAt === undefined ||
        now - lastDrawnAt >= MIN_FRAME_INTERVAL_MS ||
        time >= LOGO_INTRO_DURATION_MS
      ) {
        draw(time)
        lastDrawnAt = now
      }
      if (time < LOGO_INTRO_DURATION_MS && !reducedMotion && !document.hidden)
        animationFrame = requestAnimationFrame(animate)
    }
    const restart = (): void => {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
      animationFrame = undefined
      const now = performance.now()
      lastDrawnAt = now
      const time = elapsed(now)
      draw(time)
      if (time < LOGO_INTRO_DURATION_MS && !reducedMotion && !document.hidden)
        animationFrame = requestAnimationFrame(animate)
    }
    const resize = (): void => {
      const bounds = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)
      const width = Math.max(1, Math.round((bounds.width || 448) * dpr))
      const height = Math.max(1, Math.round((bounds.height || 224) * dpr))
      const markSize = (image.getBoundingClientRect().width || 116) * dpr
      if (
        canvas.width === width &&
        canvas.height === height &&
        metrics.markSize === markSize &&
        particles.length
      )
        return
      canvas.width = width
      canvas.height = height
      metrics = { width, height, dpr, markSize }
      particles = createLogoParticles(metrics)
      restart()
    }
    const onMotionChange = (event: MediaQueryListEvent): void => {
      reducedMotion = event.matches
      restart()
    }
    const observeResolution = (): void => {
      resolutionQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      resolutionQuery?.addEventListener('change', onResolutionChange)
    }
    const onResolutionChange = (): void => {
      resolutionQuery?.removeEventListener('change', onResolutionChange)
      resize()
      observeResolution()
    }
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
    resizeObserver?.observe(canvas)
    resizeObserver?.observe(image)
    if (!resizeObserver) window.addEventListener('resize', resize, { passive: true })
    motionQuery?.addEventListener('change', onMotionChange)
    document.addEventListener('visibilitychange', restart)
    observeResolution()
    resize()
    return () => {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
      resizeObserver?.disconnect()
      if (!resizeObserver) window.removeEventListener('resize', resize)
      motionQuery?.removeEventListener('change', onMotionChange)
      resolutionQuery?.removeEventListener('change', onResolutionChange)
      document.removeEventListener('visibilitychange', restart)
    }
  }, [])
  return (
    <div className="flex shrink-0 flex-col items-center gap-3 text-foreground" aria-hidden="true">
      <div className="relative size-44">
        <canvas
          ref={canvasRef}
          data-testid="open-science-logo-loader"
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-56 w-[min(28rem,100vw)] -translate-x-1/2 -translate-y-1/2"
        />
        <img
          ref={imageRef}
          src={logoUrl}
          alt=""
          className="pointer-events-none absolute left-1/2 top-1/2 size-29 -translate-x-1/2 -translate-y-1/2 object-contain"
        />
      </div>
      <div ref={wordmarkRef} className="flex flex-col items-center gap-3">
        <AppWordmark className="h-auto w-48" />
        <span className="text-xs tracking-widest text-muted-foreground">
          {t('Research workspace')}
        </span>
      </div>
    </div>
  )
}
// Keep existing startup gate imports and test selectors compatible with upstream.
export { EarthNanoLogoLoader, EarthNanoLogoLoader as OpenScienceLogoLoader }
