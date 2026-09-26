import { useRef, useState } from 'react'
import { DocumentInput } from './components/DocumentInput.tsx'
import { ResultsList } from './components/ResultsList.tsx'
import { SearchBar } from './components/SearchBar.tsx'
import { StatusMessage } from './components/StatusMessage.tsx'
import { documentToPassages } from './lib/passages.ts'
import { isUsingMockSearch, search, SearchFailure } from './lib/search.ts'
import { SAMPLE_DOCUMENT } from './sampleDocument.ts'
import type { SearchResult } from './types/search.ts'
import './App.css'

type SearchStatus = 'idle' | 'loading' | 'success' | 'error'

export default function App() {
  const [documentText, setDocumentText] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<SearchStatus>('idle')
  const [results, setResults] = useState<SearchResult[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const requestId = useRef(0)

  const passages = documentToPassages(documentText)
  const usingMock = isUsingMockSearch()

  function clearResults() {
    requestId.current += 1
    setStatus('idle')
    setResults([])
    setErrorMessage('')
  }

  function handleDocumentChange(value: string) {
    setDocumentText(value)
    clearResults()
  }

  function handleLoadSample() {
    setDocumentText(SAMPLE_DOCUMENT)
    clearResults()
  }

  async function handleSearch() {
    const id = ++requestId.current
    setStatus('loading')
    setResults([])
    setErrorMessage('')

    try {
      const response = await search({ query, passages })
      if (requestId.current !== id) return
      setResults(response.results)
      setStatus('success')
    } catch (error) {
      if (requestId.current !== id) return
      setStatus('error')
      setErrorMessage(
        error instanceof SearchFailure ? error.message : 'Something went wrong while searching.',
      )
    }
  }

  return (
    <main className="app">
      <header className="header">
        <p className="kicker">Playground</p>
        <h1>Tracky</h1>
        <p className="lede">
          Paste a document, then search it by meaning. Matches are sentences from that document,
          ranked by confidence.
        </p>
      </header>

      <DocumentInput
        value={documentText}
        passageCount={passages.length}
        onChange={handleDocumentChange}
        onLoadSample={handleLoadSample}
      />

      <SearchBar
        query={query}
        isSearching={status === 'loading'}
        usingMock={usingMock}
        onQueryChange={setQuery}
        onSearch={() => {
          void handleSearch()
        }}
      />

      <section className="panel" aria-labelledby="results-heading" aria-busy={status === 'loading'}>
        <h2 id="results-heading">Results</h2>
        <div aria-live="polite">
          {status === 'loading' && <StatusMessage tone="loading" message="Searching…" />}
          {status === 'idle' && (
            <StatusMessage tone="idle" message="Search a document to see matching sentences." />
          )}
          {status === 'error' && <StatusMessage tone="error" message={errorMessage} />}
          {status === 'success' && results.length === 0 && (
            <StatusMessage tone="empty" message="No matching sentences for that query." />
          )}
          {status === 'success' && results.length > 0 && <ResultsList results={results} />}
        </div>
      </section>
    </main>
  )
}
