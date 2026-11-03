/** Downloads Feishu message images as base64 attachments during assessment. */
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import type { FeishuRef } from './feishu-read.ts'
import type { ImageAttachment } from './kind.ts'

/** Extracts Feishu image keys from message text so keys remain paired with the originating message; arbitrary remote IDs are not accepted. */
export function admissionImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bimg_[a-zA-Z0-9_-]+\b/g) ?? [])]
}

/** Detects PNG/JPEG/GIF/WebP from magic bytes; `undefined` for anything else. */
function mediaTypeOf(data: Buffer): string | undefined {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return 'image/jpeg'
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

export interface AdmissionImage {
  source_message_id: string
  image_key: string
  image: ImageAttachment
}

export async function readAdmissionImage(commands: Commands, ref: FeishuRef, text: string, imageKey: string, stateDir: string, signal: AbortSignal): Promise<AdmissionImage> {
  if (!admissionImageKeys(text).includes(imageKey)) throw new Error('Choose an image key from this source message')
  const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/).parse(ref.messageId)
  signal.throwIfAborted()
  const directory = await mkdtemp(join(stateDir, 'admission-image-'))
  try {
    const result = z.object({ saved_path: z.string() }).parse(await commands.withSignal(signal).lark([
      'im', '+messages-resources-download', '--message-id', messageId, '--file-key', imageKey, '--type', 'image', '--output', './image',
    ], directory))
    const path = await realpath(result.saved_path)
    if (dirname(path) !== await realpath(directory)) throw new Error('Image download returned a path outside its temporary directory')
    const file = await stat(path)
    if (!file.isFile()) throw new Error('The downloaded resource is not a regular file')
    if (file.size > 5 * 1024 * 1024) throw new Error('Image too large')
    const data = await readFile(path, { signal })
    signal.throwIfAborted()
    const mimeType = mediaTypeOf(data)
    if (!mimeType) throw new Error('Unsupported image type')
    return { source_message_id: messageId, image_key: imageKey, image: { data: data.toString('base64'), mimeType } }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
