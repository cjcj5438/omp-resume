/** Projects settings group: one card per project with repository, chats, directory and prepare command. */
import { useRef } from 'react'
import { LIMITS } from '../limits.ts'
import type { FieldSpec } from '../sources/kind.ts'
import type { Settings, SettingsView, SourceView } from './api.ts'
import { Button, Icon, Input } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { EnvironmentVariables } from './execution.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { ConfigHistory, Field, Fields, RowsField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { ConfirmButton, Hint } from './widgets.tsx'
type Project = Settings['projects'][number]

const CHATS_FIELD: Extract<FieldSpec, { type: 'rows' }> = {
  key: 'chats',
  type: 'rows',
  label: { zh: '飞书群', en: 'Feishu chats' },
  columns: [{
    key: 'chatId',
    type: 'text',
    label: { zh: '群', en: 'Chat' },
    pattern: 'oc_[a-zA-Z0-9]+',
    choose: { zh: '选择机器人已加入的群', en: 'Choose a chat the bot has joined' },
    refresh: { zh: '刷新群列表', en: 'Refresh chats' },
  }],
}

function receivedChats(feishu: SourceView | undefined): Set<string> {
  const config = feishu?.value.config
  const raw = config && typeof config === 'object' && 'chats' in config ? config.chats : undefined
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.flatMap(item => item && typeof item === 'object' && 'chatId' in item
    && typeof item.chatId === 'string' ? [item.chatId] : []))
}

function ProjectCard({ project, locked, savedChats, workRoot, groups, sources, feishu, refreshLabels, onChange,
  onRemove }: {
  project: Project; locked: boolean; savedChats: Project['chats']; workRoot: string
  groups: SettingsView['environment']['variables']; sources: SourceView[]; feishu: SourceView | undefined
  refreshLabels: (() => Promise<string[]>) | undefined; onChange: (next: Project) => void; onRemove: () => void
}) {
  const { t } = usePanel()
  const prepare = useRef<HTMLTextAreaElement>(null)
  const edit = (next: Partial<Project>) => onChange({ ...project, ...next })
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? project.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${project.prepare.slice(0, at)}"$${key}"${project.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  const received = receivedChats(feishu)
  const missing = project.chats.filter(chat => chat.chatId && !received.has(chat.chatId))
  const name = project.name.trim() || project.id || t('projectNew')
  return <div className="dt-card">
    <div className="dt-card-head">
      <div className="dt-row-main">
        <div className="dt-row-title">
          <span className="dt-card-title">{name}</span>
        </div>
      </div>
    </div>
    <Field label={t('projectName')}>
      <Input value={project.name} required maxLength={LIMITS.projectName}
        onChange={event => edit({ name: event.target.value })} />
    </Field>
    <div className="dt-field">
      <span className="dt-field-head">{t('projectId')}</span>
      {locked ? <><span className="dt-mono">{project.id}</span><small>{t('projectIdLocked')}</small></>
        : <Input className="dt-mono" aria-label={t('projectId')} value={project.id} required pattern="[a-z][a-z0-9-]{0,31}"
          spellCheck={false} onChange={event => edit({ id: event.target.value })} />}
    </div>
    <Field label={t('projectRepository')} hint={t('projectRepositoryHint')}>
      <Input className="dt-mono" value={project.repository} required pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
        placeholder={t('projectRepositoryPlaceholder')} spellCheck={false}
        onChange={event => edit({ repository: event.target.value })} />
    </Field>
    <RowsField field={CHATS_FIELD} value={project.chats} saved={savedChats}
      onChange={next => { if (Array.isArray(next)) edit({ chats: next as Project['chats'] }) }} labels={feishu?.labels ?? {}}
      refreshLabels={refreshLabels} />
    {missing.map(chat => <Hint key={chat.chatId}>{t('projectChatMissing', { chat: feishu?.labels[chat.chatId] ?? chat.chatId })}</Hint>)}
    <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={project.directory ? undefined
      : t('projectDirectoryPlaceholder', { root: `${workRoot}/${project.id}` })}>
      <Input className="dt-mono" value={project.directory} placeholder={`${workRoot}/${project.id}`} spellCheck={false}
        pattern="/.*" onChange={event => edit({ directory: event.target.value })} />
    </Field>
    <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
      <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
        placeholder={t('prepareCommandEmpty')} value={project.prepare}
        onChange={event => edit({ prepare: event.target.value })} />
    </Field>
    <EnvironmentVariables groups={groups} sources={sources} onPick={insert} />
    <div className="dt-actions">
      <ConfirmButton variant="ghost" icon="trash" label={t('projectRemove')} title={t('projectRemove')}
        message={t('projectRemoveConfirm', { name })} onConfirm={async () => { onRemove() }} />
    </div>
  </div>
}

export function ProjectsSettings() {
  const { t, call } = usePanel()
  const { running } = usePanelData()
  const { settings, reload } = useSettings()
  const { blocks, sources, environment } = settings
  const saved = blocks.projects.value
  const draft = useBlockDraft('projects', saved, blocks.projects.revision)
  const projects = draft.value
  const savedIds = new Set(saved.map(item => item.id))
  // A card is saved-derived (its id locked) when it is the first draft entry carrying a saved id. Saved ids never
  // change and new cards are appended, so the saved original always precedes a new card that retypes its id — also in
  // a draft restored from storage — and the duplicate stays editable until the server refuses it on save.
  const seen = new Set<string>()
  const locked = projects.map(project => {
    if (project.id === '' || !savedIds.has(project.id) || seen.has(project.id)) return false
    seen.add(project.id)
    return true
  })
  const repos = (list: readonly Pick<Project, 'repository'>[]) => JSON.stringify(list.map(item => item.repository.toLowerCase()).sort())
  // Saving a changed repository set restarts Superagent, interrupting running Assignments.
  const restarts = draft.dirty && repos(projects) !== repos(saved)
  const feishu = sources.find(source => source.id === 'feishu')
  const refreshLabels = feishu ? async () => { const { added } = await call('POST sources/:id/labels',
    { id: 'feishu' }); await reload(); return added } : undefined
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        {projects.length ? projects.map((project, index) => <ProjectCard key={index} project={project}
          locked={locked[index] === true}
          savedChats={locked[index] === true ? saved.find(item => item.id === project.id)?.chats ?? [] : []}
          workRoot={environment.workRoot}
          groups={environment.variables} sources={sources} feishu={feishu} refreshLabels={refreshLabels}
          onChange={next => draft.edit(projects.map((item, position) => position === index ? next : item))}
          onRemove={() => draft.edit(projects.filter((_, position) => position !== index))} />)
          : <Hint>{t('projectsEmpty')}</Hint>}
        <div className="dt-actions">
          <Button variant="outline" size="sm" icon={<Icon name="plus" />}
            onClick={() => draft.edit([...projects, { id: '', name: '', repository: '', chats: [], directory: '',
              prepare: '' }])}>{t('projectAdd')}</Button>
        </div>
      </Fields>
      <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined}
        onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['projects']} />
  </div>
}
