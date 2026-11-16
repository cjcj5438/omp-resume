/** Project binding: the ticket directory, and which configured project a trigger or ticket belongs to. */
import { join } from 'node:path'
import type { Project, Settings } from '../policy.ts'
import type { Ticket, Trigger } from '../core/index.ts'
import { githubRepo } from '../sources/github-trigger.ts'

export const projectWorkRoot = (project: Project, stateDir: string): string =>
  project.directory || join(stateDir, 'work', project.id)

/**
 * The project a trigger belongs to: a GitHub trigger by its repository, a Feishu group trigger by its chat.
 * Feishu direct messages and triggers from other sources bind to no project.
 */
export function boundProject(settings: Settings, trigger: Trigger): Project | undefined {
  if (trigger.source === 'github') {
    const repository = String(trigger.meta.repository ?? '')
    return settings.projects.find(project => githubRepo(project.repository) === repository)
  }
  if (trigger.source === 'feishu' && trigger.meta.direct !== true) {
    const chatId = String(trigger.meta.chatId ?? '')
    return settings.projects.find(project => project.chats.some(chat => chat.chatId === chatId))
  }
  return undefined
}

export type ProjectChoice = { project: Project } | { error: string }

/**
 * Resolve the project for a trigger: a bound trigger stays on its project, an unbound one needs a requested
 * project id, or is the only configured project.
 */
export function chooseProject(settings: Settings, trigger: Trigger, requested?: string): ProjectChoice {
  const bound = boundProject(settings, trigger)
  if (bound) {
    if (requested !== undefined && requested !== bound.id) return { error: `This trigger belongs to project ${bound.id}` }
    return { project: bound }
  }
  if (requested !== undefined) {
    const project = settings.projects.find(p => p.id === requested)
    if (project) return { project }
    return { error: `Unknown project ${requested}; projects: ${settings.projects.map(p => p.id).join(', ')}` }
  }
  if (settings.projects.length === 1) return { project: settings.projects[0]! }
  return { error: `Name the project: this trigger is not bound to one. Projects: ${settings.projects.map(p => p.id).join(', ')}` }
}

export const projectOfTicket = (settings: Settings, ticket: Ticket): Project | undefined =>
  settings.projects.find(p => p.id === ticket.execution?.project)
