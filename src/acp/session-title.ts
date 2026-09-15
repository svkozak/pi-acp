export function titleFromContent(content: unknown): string | null {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((block: unknown) => {
              if (!block || typeof block !== 'object') return []
              const { type, text } = block as { type?: unknown; text?: unknown }
              return type === 'text' && typeof text === 'string' ? [text] : []
            })
            .join(' ')
        : ''

  return Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, 80).join('') || null
}
