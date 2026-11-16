/** Trigger status view listing Threads filtered by subscription and evaluation activity. */
import { useState } from 'react'
import { THREAD_FILTERS, type ThreadFilter } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Pill } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { ProjectSelect, ThreadLine } from './rows.tsx'
import { Hint, LoadMore, LoadState, StatusHead } from './widgets.tsx'

export function TriggerStatus({ filter, project }: { filter: ThreadFilter; project: string | undefined }) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error } = usePoll(() => call('GET threads', { query: { filter, limit,
    ...project ? { project } : {} } }), [filter, limit, project])
  const { data: settings } = usePoll(() => call('GET settings'), [])
  const go = (next: ThreadFilter) => { setLimit(20); navigate({ page: 'trigger',
    query: { ...next !== 'subscribed' ? { filter: next } : {}, ...project ? { project } : {} } }, true) }
  const pick = (value: string | undefined) => { setLimit(20); navigate({ page: 'trigger',
    query: { ...filter !== 'subscribed' ? { filter } : {}, ...value ? { project: value } : {} } }, true) }
  return <>
    <StatusHead hint={t('triggerIntro')} />
    <div className="dt-filters">
      {THREAD_FILTERS.map(value => <Pill key={value} active={filter === value}
        onClick={() => go(value)}>{t(`threadFilter.${value}`)}</Pill>)}
      <ProjectSelect projects={settings?.blocks.projects.value ?? []} value={project} onChange={pick} />
    </div>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(thread => <ThreadLine key={thread.key} thread={thread} />)}</ul>
      : <Hint>{t('threadsNone')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}
