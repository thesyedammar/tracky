type StatusMessageProps = {
  tone: 'idle' | 'loading' | 'empty' | 'error'
  message: string
}

export function StatusMessage({ tone, message }: StatusMessageProps) {
  return (
    <p className={`status status-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {message}
    </p>
  )
}
