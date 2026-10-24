import type { ComponentPropsWithoutRef } from 'react'
import lightWordmark from '@/assets/oneearth-wordmark.svg'
import darkWordmark from '@/assets/oneearth-wordmark-dark.svg'
import { useThemeStore } from '@/stores/theme-store'
import { APP } from '../../../shared/app-config'

// Preserve the supplied letter outlines and red R stem; follow the application's theme.
export const AppWordmark = ({
  alt = APP.name,
  ...props
}: Omit<ComponentPropsWithoutRef<'img'>, 'src'>): React.JSX.Element => {
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme)
  return <img {...props} src={resolvedTheme === 'dark' ? darkWordmark : lightWordmark} alt={alt} />
}
