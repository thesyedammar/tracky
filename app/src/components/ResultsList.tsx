import type { SearchResult } from '../types/search.ts'
import { ResultItem } from './ResultItem.tsx'

type ResultsListProps = {
  results: SearchResult[]
}

export function ResultsList({ results }: ResultsListProps) {
  const label = results.length === 1 ? '1 match' : `${results.length} matches`

  return (
    <>
      <p className="hint">{label}, highest confidence first.</p>
      <ol className="results">
        {results.map((result) => (
          <ResultItem key={`${result.passageId}:${result.sentence}`} result={result} />
        ))}
      </ol>
    </>
  )
}
