import type { SearchRequest, SearchResponse, SearchResult } from '../types/search.ts'
import { mockSearch } from './mockSearch.ts'
import { SearchFailure } from './searchFailure.ts'

export { SearchFailure } from './searchFailure.ts'

/**
 * The UI calls search() and nothing else.
 * Leave VITE_SEARCH_URL unset to use app/mock/.
 * Set VITE_SEARCH_URL=http://127.0.0.1:4199/api/search to call the helper.
 */
function helperEndpoint(): string | null {
  const configured = import.meta.env.VITE_SEARCH_URL
  if (typeof configured !== 'string') return null
  const trimmed = configured.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function isUsingMockSearch(): boolean {
  return helperEndpoint() === null
}

function validateRequest(request: SearchRequest): string {
  const query = request.query.trim()

  if (query.length < 1) {
    throw new SearchFailure('Enter a query (1–1,000 characters).')
  }

  if (query.length > 1000) {
    throw new SearchFailure('Query must be 1,000 characters or fewer.')
  }

  if (request.passages.length < 1) {
    throw new SearchFailure('Add a document with at least one passage.')
  }

  if (request.passages.length > 600) {
    throw new SearchFailure('A document can have at most 600 passages.')
  }

  for (const passage of request.passages) {
    if (passage.text.length > 2200) {
      throw new SearchFailure('Each passage must be 2,200 characters or fewer.')
    }
  }

  const combinedLength = request.passages.reduce((sum, passage) => sum + passage.text.length, 0)
  if (combinedLength > 400_000) {
    throw new SearchFailure('Document is too large to search.')
  }

  return query
}

function sortByScore(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => b.score - a.score)
}

function isSearchResult(value: unknown): value is SearchResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<SearchResult>
  return (
    typeof result.passageId === 'string' &&
    typeof result.sentence === 'string' &&
    typeof result.score === 'number'
  )
}

function isSearchResponse(value: unknown): value is SearchResponse {
  if (!value || typeof value !== 'object' || !('results' in value)) return false
  const { results } = value as { results: unknown }
  return Array.isArray(results) && results.every(isSearchResult)
}

function errorMessage(body: unknown, status: number): string {
  if (
    body &&
    typeof body === 'object' &&
    'message' in body &&
    typeof body.message === 'string' &&
    body.message.trim().length > 0
  ) {
    return body.message
  }

  return `Search failed (${status}).`
}

async function remoteSearch(url: string, request: SearchRequest): Promise<SearchResponse> {
  let response: Response

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch {
    throw new SearchFailure('Helper is not running.')
  }

  const body: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    throw new SearchFailure(errorMessage(body, response.status))
  }

  if (!isSearchResponse(body)) {
    throw new SearchFailure('Helper returned an unexpected response.')
  }

  return body
}

export async function search(request: SearchRequest): Promise<SearchResponse> {
  const query = validateRequest(request)
  const payload: SearchRequest = { query, passages: request.passages }
  const endpoint = helperEndpoint()
  const response = endpoint ? await remoteSearch(endpoint, payload) : await mockSearch(payload)

  return { results: sortByScore(response.results) }
}
