import type { Passage } from '../types/search.ts'

/**
 * Split a pasted document into the blocks the search API calls passages.
 * Blank lines separate blocks. The helper chunks further; this client does not.
 */
export function documentToPassages(documentText: string): Passage[] {
  return documentText
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((text, index) => ({
      id: `p${index}`,
      text,
    }))
}
