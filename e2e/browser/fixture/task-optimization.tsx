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
import {
  minimumSweepExecutions,
  type PreviewDesktopSweep,
  type StartDesktopSweep
} from '../../../src/shared/earthnano/optimization-sweep'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../src/shared/web-event-connection'
const params = new URLSearchParams(location.search)
const calls: {
  start: StartDesktopOptimization[]
  sweeps: StartDesktopSweep[]
  previews: PreviewDesktopSweep[]
  get: number
  stop: number
  latest: string[]
  sessions: string[]
  reviews: string[]
} = { start: [], sweeps: [], previews: [], get: 0, stop: 0, latest: [], sessions: [], reviews: [] }
Object.assign(window, { optimizationFixture: calls })
if (params.has('web')) document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
const progress = (state: OptimizationProgress['state'] = 'running'): OptimizationProgress => {
  const request = calls.sweeps.at(-1)
  return {
    runId: 'fixture-run',
    projectId: 'project',
    sourceSessionId: 'session',
    state,
    stage: 'baseline',
    budget: {
      limit: request?.executionLimit ?? 12,
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
      {
        executionId: 'final',
        role: 'candidate',
        phase: 'completed',
        sessionId: 'candidate-session'
      }
    ],
    ...(request
      ? {
          sweep: {
            planDigest: 'sha256:' + 'a'.repeat(64),
            modes: request.sweep.modes,
            order: [...new Set(request.catalog.map((task) => task.domain))].map((domain) => ({
              domain,
              taskIds: request.catalog
                .filter((task) => task.domain === domain)
                .map((task) => task.taskId)
            })),
            domains: request.sweep.modes.flatMap((mode) =>
              [...new Set(request.catalog.map((task) => task.domain))].map((domain) => ({
                mode,
                summary: {
                  name: domain,
                  order: request.catalog
                    .filter((task) => task.domain === domain)
                    .map((task) => task.taskId),
                  library: { scope: 'experiment' as const, entries: [], digest: 'fixture-library' },
                  tasks:
                    state === 'completed'
                      ? request.catalog
                          .filter((task) => task.domain === domain)
                          .map((task, index) => ({
                            taskId: task.taskId,
                            outcome: index
                              ? {
                                  artifact: {
                                    status: 'failed' as const,
                                    checks: [
                                      {
                                        path: 'result.json',
                                        pointer: '',
                                        status: 'fail' as const,
                                        reason: 'mismatch' as const
                                      }
                                    ]
                                  },
                                  configuration: {
                                    status: 'blocked' as const,
                                    reasons: ['output-check-failed']
                                  }
                                }
                              : {
                                  artifact: { status: 'passed' as const, checks: [] },
                                  configuration: { status: 'eligible' as const, reasons: [] }
                                },
                            selection: {
                              chosenLabel: mode === 'parallel' ? 'agg2' : 'c2',
                              candidateCount: request.sweep.k,
                              trivial: request.sweep.k === 1,
                              fallback: false,
                              reason: 'Selected from the fixed candidate outputs.'
                            },
                            assessments: {
                              baseline: {
                                executionId: 'review-a',
                                targetExecutionId: 'baseline',
                                reviewId: 'review-baseline',
                                outcome: 'pass' as const,
                                score: 80,
                                rationale: 'Baseline satisfies the independent criteria.'
                              },
                              candidate: {
                                executionId: 'review-b',
                                targetExecutionId: 'final',
                                reviewId: 'review-candidate',
                                outcome: 'pass' as const,
                                score: 80,
                                rationale: 'Candidate satisfies the same independent criteria.'
                              }
                            }
                          }))
                      : []
                }
              }))
            )
          }
        }
      : {}),
    updatedAt: 1
  }
}
const api: DesktopOptimizationApi = {
  // UI fixture only. Scientific source ordering/filter semantics are verified against real Python
  // in Main/native tests; this deterministic fixture has an unfiltered catalog.
  previewSweep: async (request) => {
    calls.previews.push(request)
    return {
      planDigest: 'sha256:' + 'a'.repeat(64),
      modes: request.sweep.modes,
      order: [...new Set(request.catalog.map((task) => task.domain))].map((domain) => ({
        domain,
        taskIds: request.catalog.filter((task) => task.domain === domain).map((task) => task.taskId)
      })),
      minimumExecutions: minimumSweepExecutions(request.sweep, request.catalog.length)
    }
  },
  startSweep: async (request) => {
    calls.sweeps.push(request)
    if (params.has('error')) throw new Error('synthetic-secret')
    return progress()
  },
  start: async (request) => {
    calls.start.push(request)
    throw new Error('New UI experiments require the shared sweep entry')
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
  },
  resume: async () => progress('running')
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
