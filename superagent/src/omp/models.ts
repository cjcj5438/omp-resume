/** Model catalog from the omp CLI: chat models grouped by provider, with the configured default role model. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { RoleModel } from '../policy.ts'

const run = promisify(execFile)
const ModelsOutput = z.looseObject({ models: z.array(z.looseObject({
  provider: z.string(), kind: z.string(), id: z.string(), name: z.string(),
  thinking: z.array(z.string()).nullable().optional(), input: z.array(z.string()).optional(),
})) })
const RolesOutput = z.looseObject({ value: z.looseObject({ default: z.string().optional() }).catchall(z.unknown()) })

export interface ModelCatalog {
  groups: { id: string; name: string; models: { id: string; name: string
    reasoning?: { efforts: { id: string; name: string }[] }; vision: boolean }[] }[]
  default: RoleModel | null
}

/** Parses a `provider/model[:effort]` role value; the provider splits at the first `/`, the effort at the last `:`. */
function parseDefault(value: string): RoleModel | null {
  const slash = value.indexOf('/')
  if (slash <= 0) return null
  const provider = value.slice(0, slash).trim(), rest = value.slice(slash + 1).trim()
  if (!provider || !rest) return null
  const colon = rest.lastIndexOf(':')
  const model = (colon >= 0 ? rest.slice(0, colon) : rest).trim()
  const effort = colon >= 0 ? rest.slice(colon + 1).trim() : ''
  if (!model) return null
  return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
}

const cached = new Map<string, { at: number; catalog: ModelCatalog }>()
const pending = new Map<string, Promise<ModelCatalog>>()
/** Loads the catalog via `omp models --json`, cached for 10 minutes with single-flight per binary. */
export function modelCatalog(ompBin: string): Promise<ModelCatalog> {
  const hit = cached.get(ompBin)
  if (hit && Date.now() - hit.at < 10 * 60_000) return Promise.resolve(hit.catalog)
  const flight = pending.get(ompBin)
  if (flight) return flight
  const loaded = (async (): Promise<ModelCatalog> => {
    const [{ stdout }, rolesOut] = await Promise.all([
      run(ompBin, ['models', '--json'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }),
      run(ompBin, ['config', 'get', 'modelRoles', '--json'], { timeout: 30_000, maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: '' })),
    ])
    const parsed = ModelsOutput.parse(JSON.parse(stdout))
    const byProvider = new Map<string, ModelCatalog['groups'][number]>()
    for (const item of parsed.models) {
      if (item.kind !== 'chat') continue
      let group = byProvider.get(item.provider)
      if (!group) { group = { id: item.provider, name: item.provider, models: [] }; byProvider.set(item.provider, group) }
      group.models.push({ id: item.id, name: item.name,
        ...(item.thinking?.length ? { reasoning: { efforts: item.thinking.map(effort => ({ id: effort, name: effort })) } } : {}),
        vision: item.input?.includes('image') ?? false })
    }
    let fallback: RoleModel | null = null
    try {
      const value = RolesOutput.parse(JSON.parse(rolesOut.stdout)).value.default
      fallback = value ? parseDefault(value) : null
    } catch { /* No configured default. */ }
    const catalog: ModelCatalog = { groups: [...byProvider.values()], default: fallback }
    cached.set(ompBin, { at: Date.now(), catalog })
    return catalog
  })()
  pending.set(ompBin, loaded)
  return loaded.finally(() => { pending.delete(ompBin) })
}

/** Validates a role model against the catalog; returns an error message when the provider, model, or effort is unknown. */
export function checkRoleModel(catalog: ModelCatalog, model: RoleModel): string | undefined {
  const group = catalog.groups.find(item => item.id === model.provider)
  if (!group) return `Unknown model provider ${model.provider}`
  const entry = group.models.find(item => item.id === model.model)
  if (!entry) return `Unknown model ${model.provider}/${model.model}`
  if (model.reasoningEffort && !entry.reasoning?.efforts.some(effort => effort.id === model.reasoningEffort)) {
    return `Unknown reasoning effort ${model.reasoningEffort} for ${model.provider}/${model.model}`
  }
  return undefined
}
