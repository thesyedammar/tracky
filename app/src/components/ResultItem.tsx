import type { SearchResult } from '../types/search.ts'

type ResultItemProps = {
  result: SearchResult
}

export function ResultItem({ result }: ResultItemProps) {
  const width = Math.min(100, Math.max(0, result.score * 100))

  return (
    <li className="result">
      <p className="sentence">{result.sentence}</p>
      <div className="result-meta">
        <span>Confidence {result.score.toFixed(2)}</span>
        <span>Passage {result.passageId}</span>
      </div>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${width}%` }} />
      </div>
    </li>
  )
}
