import { describe, expect, it } from 'vitest'
import { SettingsSchema, type Project, type Settings } from '../src/policy.ts'
import { boundProject, chooseProject, projectOfTicket, projectWorkRoot, type ProjectChoice } from '../src/app/projects.ts'
import { projectIdFrom } from '../src/app/migration.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

const project = (overrides: Partial<Project> & { id: string }): Project =>
  ({ name: overrides.id, repository: 'acme/app', chats: [], directory: '', prepare: '', ...overrides })
const settings = (projects: Project[]): Settings => SettingsSchema.parse({ projects })
const trigger = (overrides: Partial<Trigger> & { source: string; meta?: Record<string, unknown> }): Trigger => {
  const { source, ...rest } = overrides
  return { id: 't', source, threads: [], actor: { source, id: 'u' }, human: true, at: '', text: 'hi', meta: {}, ...rest }
}
const projectOf = (choice: ProjectChoice): Project | undefined => 'project' in choice ? choice.project : undefined
const errorOf = (choice: ProjectChoice): string | undefined => 'error' in choice ? choice.error : undefined

const github = trigger({ source: 'github', meta: { repository: 'acme/app' } })
const group = trigger({ source: 'feishu', meta: { chatId: 'oc_team', direct: false } })
const dm = trigger({ source: 'feishu', meta: { chatId: 'oc_dm', direct: true } })

describe('projectWorkRoot', () => {
  it('uses the configured directory, else the state work directory for the project id', () => {
    expect(projectWorkRoot(project({ id: 'a', directory: '/data/a' }), '/state')).toBe('/data/a')
    expect(projectWorkRoot(project({ id: 'a' }), '/state')).toBe('/state/work/a')
  })
})

describe('boundProject', () => {
  const configured = settings([project({ id: 'a', repository: 'Acme/App', chats: [{ chatId: 'oc_team' }] })])
  it('binds a GitHub trigger by repository, case-insensitively', () => {
    expect(boundProject(configured, github)?.id).toBe('a')
    expect(boundProject(configured, trigger({ source: 'github', meta: { repository: 'acme/other' } }))).toBeUndefined()
  })
  it('binds a Feishu group trigger by chat, but not a DM or an unlisted chat', () => {
    expect(boundProject(configured, group)?.id).toBe('a')
    expect(boundProject(configured, dm)).toBeUndefined()
    expect(boundProject(configured, trigger({ source: 'feishu', meta: { chatId: 'oc_other', direct: false } }))).toBeUndefined()
  })
  it('binds nothing from other sources', () => {
    expect(boundProject(configured, trigger({ source: 'slack', meta: {} }))).toBeUndefined()
  })
})

describe('chooseProject', () => {
  const single = settings([project({ id: 'a' })])
  const multi = settings([project({ id: 'a', repository: 'acme/app', chats: [{ chatId: 'oc_team' }] }),
    project({ id: 'b', repository: 'acme/other', chats: [{ chatId: 'oc_other' }] })])
  it('keeps a bound trigger on its project, rejecting another requested id', () => {
    expect(projectOf(chooseProject(multi, github))?.id).toBe('a')
    expect(projectOf(chooseProject(multi, group))?.id).toBe('a')
    expect(errorOf(chooseProject(multi, github, 'b'))).toBe('This trigger belongs to project a')
  })
  it('resolves an unbound trigger by requested id, naming the configured projects when unknown', () => {
    expect(projectOf(chooseProject(multi, dm, 'b'))?.id).toBe('b')
    expect(errorOf(chooseProject(multi, dm, 'c'))).toBe('Unknown project c; projects: a, b')
  })
  it('defaults an unbound trigger to the only project, or asks for a name', () => {
    expect(projectOf(chooseProject(single, dm))?.id).toBe('a')
    expect(errorOf(chooseProject(multi, dm))).toBe('Name the project: this trigger is not bound to one. Projects: a, b')
  })
})

describe('projectOfTicket', () => {
  it('finds the ticket execution project, else undefined', () => {
    const configured = settings([project({ id: 'a' })])
    expect(projectOfTicket(configured, { execution: { project: 'a' } } as unknown as Ticket)?.id).toBe('a')
    expect(projectOfTicket(configured, { execution: { project: 'gone' } } as unknown as Ticket)).toBeUndefined()
    expect(projectOfTicket(configured, {} as unknown as Ticket)).toBeUndefined()
  })
})

describe('projectIdFrom', () => {
  it('derives lowercase ids from repository names', () => {
    expect(projectIdFrom('cjcj5438/omp-resume')).toBe('omp-resume')
    expect(projectIdFrom('acme/abcdefghijklmnopqrstuvwxyz-0123456789-x')).toBe('abcdefghijklmnopqrstuvwxyz-01234')
    expect(projectIdFrom('Acme/My.App_Name')).toBe('my-app-name')
    expect(projectIdFrom('acme/9lives')).toBe('p-9lives')
  })
})
