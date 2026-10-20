import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { TaskOptimizationPanel } from '@/pages/workspace/TaskOptimizationPanel'
import type {
  DesktopOptimizationApi,
  OptimizationProgress,
  StartDesktopOptimization
} from '../../../src/shared/earthnano/desktop-optimization'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../src/shared/web-event-connection'
const params = new URLSearchParams(location.search)
const calls: {
  start: StartDesktopOptimization[]
  get: number
  stop: number
  latest: string[]
  sessions: string[]
  reviews: string[]
} = { start: [], get: 0, stop: 0, latest: [], sessions: [], reviews: [] }
Object.assign(window, { optimizationFixture: calls })
if (params.has('web')) document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
const progress = (state: OptimizationProgress['state'] = 'running'): OptimizationProgress => ({
  runId: 'fixture-run',
  projectId: 'project',
  sourceSessionId: 'session',
  state,
  stage: 'baseline',
  ...(calls.start.at(-1)?.method ? { method: calls.start.at(-1)!.method } : {}),
  budget: {
    limit: calls.start.at(-1)?.executionLimit ?? 12,
    admitted: state === 'completed' ? 9 : 2,
    completed: state === 'completed' ? 9 : 1,
    active: state === 'completed' ? 0 : 1
  },
  executions: [
    {
      executionId: 'baseline',
      role: 'baseline',
      phase: 'completed',
      sessionId: 'baseline-session'
    },
    { executionId: 'final', role: 'candidate', phase: 'completed', sessionId: 'candidate-session' }
  ],
  updatedAt: 1,
  ...(state === 'completed' && (calls.start.at(-1)?.method?.k ?? 1) > 1
    ? {
        selection: {
          chosenLabel: calls.start.at(-1)?.method?.mode === 'parallel' ? 'agg2' : 'c2',
          candidateCount: 2,
          trivial: false,
          fallback: false,
          reason: 'Selected from the two fixed candidate outputs.'
        }
      }
    : {}),
  ...(state === 'completed'
    ? {
        assessments: {
          baseline: {
            executionId: 'review-a',
            targetExecutionId: 'baseline',
            reviewId: 'review-baseline',
            outcome: 'pass',
            score: 80,
            rationale: 'Baseline satisfies the independent criteria.'
          },
          candidate: {
            executionId: 'review-b',
            targetExecutionId: 'final',
            reviewId: 'review-candidate',
            outcome: 'pass',
            score: 80,
            rationale: 'Candidate satisfies the same independent criteria.'
          }
        }
      }
    : {})
})
const api: DesktopOptimizationApi = {
  start: async (request) => {
    calls.start.push(request)
    if (params.has('error')) throw new Error('synthetic-secret')
    return progress()
  },
  get: async () => {
    calls.get++
    return progress(params.has('complete') ? 'completed' : 'running')
  },
  latest: async (request) => {
    calls.latest.push(request.sourceSessionId)
    return null
  },
  stop: async () => {
    calls.stop++
    return progress('cancelled')
  }
}
export function Fixture(): React.JSX.Element {
  const [session, setSession] = useState('session')
  return (
    <main className="mx-auto max-w-3xl p-4">
      <button type="button" onClick={() => setSession('next')}>
        Switch source chat
      </button>
      <TaskOptimizationPanel
        projectId="project"
        sessionId={session}
        initialPrompt={`Synthetic task ${session}`}
        api={api}
        onOpenSession={(id) => calls.sessions.push(id)}
        onOpenReview={(_id, review) => calls.reviews.push(review)}
      />
    </main>
  )
}
void Promise.resolve(prepareI18nLocale('en')).then(() => {
  initI18n('en')
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
