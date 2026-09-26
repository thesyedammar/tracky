type SearchBarProps = {
  query: string
  isSearching: boolean
  usingMock: boolean
  onQueryChange: (query: string) => void
  onSearch: () => void
}

export function SearchBar({
  query,
  isSearching,
  usingMock,
  onQueryChange,
  onSearch,
}: SearchBarProps) {
  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault()
        onSearch()
      }}
    >
      <label htmlFor="query">Search</label>
      <div className="search-row">
        <input
          id="query"
          type="search"
          value={query}
          placeholder="hidden charges"
          aria-describedby="search-hint"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <button type="submit" disabled={isSearching}>
          {isSearching ? 'Searching…' : 'Search'}
        </button>
      </div>
      <p id="search-hint" className="hint">
        {usingMock
          ? 'Mock mode reads app/mock/search.json when the sample document is loaded. Search for empty or error to preview the other mock files.'
          : 'Searches are sent to the local helper.'}
      </p>
    </form>
  )
}
