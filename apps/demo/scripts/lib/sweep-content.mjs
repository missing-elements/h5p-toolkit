import { ContentGenerator, librariesIn, libraryString } from '@missing-elements/h5p-author'

/**
 * h5p-author's generator as the sweep runs it, lenient so every type plays: a required field with no
 * default gets its label, a pattern's first sample, 1 in range, the first option, a sub-content or media.
 */

export { ContentGenerator, librariesIn, libraryString }

/** The files a generated value may point at, under `content/`, and what each one is. */
export const MEDIA = {
  image: { path: 'images/sample.png', mime: 'image/png', width: 640, height: 360 },
  video: { path: 'videos/sample.mp4', mime: 'video/mp4' },
  audio: { path: 'audios/sample.wav', mime: 'audio/wav' },
  file: { path: 'files/sample.txt', mime: 'text/plain' }
}

/**
 * Text tried in order for a required field with a pattern and no default: the first that matches
 * is used. Covers every pattern in the pack on 2026-10-14.
 */
const PATTERNED_SAMPLES = ['Sample', '#808080', 'https://example.org/', 'sample@example.org', '+1 555 0100', '2026/1/1', '12:00', '2026,1,1', '100px', '0', 'a']

/** @type {import('@missing-elements/h5p-author').GeneratorOptions} */
export const sweepOptions = {
  lenient: true,
  // Numbered, so a package is the same bytes every run.
  id: (count) => `00000000-0000-4000-8000-${count.toString(16).padStart(12, '0')}`,
  fill(field, { generator, stack }) {
    switch (field.type) {
      case 'library':
        return generator.library(field, stack)
      case 'text':
        return sampleText(field)
      case 'number':
        return Math.max(field.min ?? 0, Math.min(field.max ?? Infinity, 1))
      case 'select':
        return field.options?.length ? field.options[0].value : undefined
      case 'image':
      case 'file':
        return { ...MEDIA[field.type], copyright: { license: 'U' } }
      case 'video':
      case 'audio':
        return [{ path: MEDIA[field.type].path, mime: MEDIA[field.type].mime, copyright: { license: 'U' } }]
      default:
        return undefined
    }
  }
}

/** The sample files the parameters point at, by kind. */
export function mediaIn(params) {
  const text = JSON.stringify(params)
  return /** @type {(keyof typeof MEDIA)[]} */ (Object.keys(MEDIA)).filter((kind) => text.includes(`"${MEDIA[kind].path}"`))
}

/**
 * Text for a required field: its label, as an editor would show it, as markup for an HTML
 * field, or the first sample its pattern accepts.
 * @param {any} field
 */
function sampleText(field) {
  if (field.regexp?.pattern) {
    const pattern = new RegExp(field.regexp.pattern, field.regexp.modifiers ?? '')
    return PATTERNED_SAMPLES.find((candidate) => pattern.test(candidate)) ?? ''
  }
  const label = typeof field.label === 'string' && field.label.trim() ? field.label.trim() : 'Sample'
  const text = field.maxLength ? label.slice(0, field.maxLength) : label
  return field.widget === 'html' ? `<p>${escapeHtml(text)}</p>` : text
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character])
}
