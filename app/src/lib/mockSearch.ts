import errorBody from '../../mock/search-error.json'
import emptyBody from '../../mock/search-empty.json'
import happyBody from '../../mock/search.json'
import type { SearchRequest, SearchResponse } from '../types/search.ts'
import { SearchFailure } from './searchFailure.ts'

const MOCK_DELAY_MS = 400

const happy = happyBody satisfies SearchResponse
const empty = emptyBody satisfies SearchResponse

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function mockMatchesDocument(request: SearchRequest): boolean {
  return happy.results.every((result) => {
    const passage = request.passages.find((item) => item.id === result.passageId)
    return passage !== undefined && passage.text.includes(result.sentence)
  })
}

/**
 * Stand-in for POST /api/search. Result text always comes from app/mock/.
 * Queries "empty" and "error" select the other two fixture files.
 */
export async function mockSearch(request: SearchRequest): Promise<SearchResponse> {
  await wait(MOCK_DELAY_MS)

  const query = request.query.trim().toLowerCase()

  if (query === 'error') {
    throw new SearchFailure(errorBody.message)
  }

  if (query === 'empty') {
    return empty
  }

  if (!mockMatchesDocument(request)) {
    throw new SearchFailure(
      'This mock only has matches for the sample document. Load the sample, or set VITE_SEARCH_URL when the helper is running.',
    )
  }

  return happy
}
