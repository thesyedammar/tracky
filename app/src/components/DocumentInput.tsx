type DocumentInputProps = {
  value: string
  passageCount: number
  onChange: (value: string) => void
  onLoadSample: () => void
}

export function DocumentInput({
  value,
  passageCount,
  onChange,
  onLoadSample,
}: DocumentInputProps) {
  const passageLabel =
    passageCount === 0
      ? 'Blank lines separate passages.'
      : `${passageCount} passage${passageCount === 1 ? '' : 's'} ready to search.`

  return (
    <section className="panel">
      <label htmlFor="document">Document</label>
      <textarea
        id="document"
        value={value}
        rows={12}
        placeholder="Paste an article, policy, or terms page."
        aria-describedby="document-hint"
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="document-actions">
        <button type="button" className="secondary" onClick={onLoadSample}>
          Load sample document
        </button>
        <p id="document-hint" className="hint">
          {passageLabel}
        </p>
      </div>
    </section>
  )
}
