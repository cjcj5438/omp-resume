import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { admissionImageKeys, readAdmissionImage } from '../src/sources/feishu-image.ts'
import type { FeishuRef } from '../src/sources/feishu-read.ts'

let directory: string
let lark: MockInstance<Commands['lark']>
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
const source: FeishuRef = { triggerId: 'source', chatId: 'oc_chat', messageId: 'om_source' }
const text = '![Image](img_source) Plan mode'
const signal = () => new AbortController().signal
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('data')])
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'admission-image-test-'))
  lark = vi.spyOn(Commands.prototype, 'lark').mockImplementation(async (args: string[], cwd?: string) => {
    expect(args).toEqual(['im', '+messages-resources-download', '--message-id', 'om_source', '--file-key', 'img_source', '--type', 'image', '--output', './image'])
    expect(cwd).toContain(directory)
    const saved_path = join(cwd!, 'image'); await writeFile(saved_path, PNG)
    return { saved_path }
  })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })
it('retains the source-message pairing, returns a base64 image and removes temporary files', async () => {
  expect(admissionImageKeys('![Image](img_source) {"image_key":"img_second"} img_source')).toEqual(['img_source', 'img_second'])
  expect(await readAdmissionImage(commands, source, text, 'img_source', directory, signal())).toEqual({ source_message_id: 'om_source',
    image_key: 'img_source', image: { data: PNG.toString('base64'), mimeType: 'image/png' } })
  expect(await readdir(directory)).toEqual([])
})
it('rejects arbitrary keys before downloading', async () => {
  await expect(readAdmissionImage(commands, source, text, '../img_other', directory, signal())).rejects.toThrow('source message')
  expect(lark).not.toHaveBeenCalled()
})
it('cleans up failed downloads without returning an image', async () => {
  lark.mockRejectedValueOnce(new Error('Resource permission denied'))
  await expect(readAdmissionImage(commands, source, text, 'img_source', directory, signal())).rejects.toThrow('permission denied')
  expect(await readdir(directory)).toEqual([])
})
it('refuses escaped output paths, oversize files and unsupported types', async () => {
  const outside = join(directory, 'outside.png'); await writeFile(outside, PNG)
  lark.mockResolvedValueOnce({ saved_path: outside })
  await expect(readAdmissionImage(commands, source, text, 'img_source', directory, signal())).rejects.toThrow('outside')
  lark.mockImplementationOnce(async (_args, cwd) => {
    const saved_path = join(cwd!, 'image'); await writeFile(saved_path, Buffer.alloc(5 * 1024 * 1024 + 1)); return { saved_path }
  })
  await expect(readAdmissionImage(commands, source, text, 'img_source', directory, signal())).rejects.toThrow('Image too large')
  lark.mockImplementationOnce(async (_args, cwd) => {
    const saved_path = join(cwd!, 'image'); await writeFile(saved_path, Buffer.from('<svg></svg>')); return { saved_path }
  })
  await expect(readAdmissionImage(commands, source, text, 'img_source', directory, signal())).rejects.toThrow('Unsupported image type')
  expect(await readdir(directory)).toEqual(['outside.png'])
})
