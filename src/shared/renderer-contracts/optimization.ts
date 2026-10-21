import type { DesktopOptimizationApi } from '../earthnano/desktop-optimization'
import { callable, ELECTRON } from './definition'

export const contracts = {
  'optimization.previewSweep': callable<DesktopOptimizationApi['previewSweep']>()('optimization', [
    'optimization:previewSweep',
    ELECTRON
  ]),
  'optimization.startSweep': callable<DesktopOptimizationApi['startSweep']>()('optimization', [
    'optimization:startSweep',
    ELECTRON
  ]),
  'optimization.start': callable<DesktopOptimizationApi['start']>()('optimization', [
    'optimization:start',
    ELECTRON
  ]),
  'optimization.get': callable<DesktopOptimizationApi['get']>()('optimization', [
    'optimization:get',
    ELECTRON
  ]),
  'optimization.latest': callable<DesktopOptimizationApi['latest']>()('optimization', [
    'optimization:latest',
    ELECTRON
  ]),
  'optimization.stop': callable<DesktopOptimizationApi['stop']>()('optimization', [
    'optimization:stop',
    ELECTRON
  ]),
  'optimization.resume': callable<DesktopOptimizationApi['resume']>()('optimization', [
    'optimization:resume',
    ELECTRON
  ])
} as const
