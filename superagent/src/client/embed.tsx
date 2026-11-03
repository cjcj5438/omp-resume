/** Embeddable Superagent management panel: transport-driven entry for host apps. */
import { useMemo, type ReactElement } from 'react'
import { App } from './app.tsx'
import type { Transport, TransportResponse } from './api.ts'
import { TransportUnavailable } from './api.ts'
import { en, zh } from './locales.ts'
import { createT } from './text.ts'

export type { Transport, TransportResponse } from './api.ts'
export { TransportUnavailable } from './api.ts'

export interface SuperagentPanelProps { transport: Transport; openSession: (sessionId: string) => void; lang?: 'zh' | 'en' }
export function SuperagentPanel({ transport, openSession, lang = 'zh' }: SuperagentPanelProps): ReactElement {
  const t = useMemo(() => createT(lang === 'en' ? en : zh), [lang])
  return <App t={t} transport={transport} openSession={async id => { openSession(id) }} />
}
