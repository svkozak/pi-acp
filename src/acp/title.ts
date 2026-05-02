export function buildTitlePrompt(firstPrompt: string): string {
  return [
    'Generate a concise title for this coding-agent thread.',
    '',
    'Rules:',
    '- Return only the title.',
    '- Use 3 to 7 words.',
    '- No markdown.',
    '- No surrounding quotes.',
    '- No trailing punctuation.',
    '- Prefer specific nouns and verbs from the request.',
    '',
    "User's first prompt:",
    firstPrompt
  ].join('\n')
}

export function sanitizeGeneratedTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?。]+$/g, '')
    .slice(0, 80)
    .trim()
}

export function fallbackTitleFromPrompt(prompt: string): string {
  return prompt
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?。]+$/g, '')
    .split(' ')
    .slice(0, 8)
    .join(' ')
    .slice(0, 80)
    .trim()
}

export function shouldAutoTitlePrompt(message: string): boolean {
  const trimmed = message.trim()
  return trimmed.length > 0 && !trimmed.startsWith('/')
}
