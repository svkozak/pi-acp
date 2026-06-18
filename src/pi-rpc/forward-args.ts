export function getForwardedPiArgs(argv: string[] = process.argv.slice(2)): string[] {
  const out: string[] = []
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]

    if (arg === '--') {
      out.push(...argv.slice(i + 1))
      break
    }

    if (arg === '--terminal-login' || arg === '--no-themes') {
      i++
      continue
    }

    if (arg === '--mode' || arg === '--session') {
      i += 2
      continue
    }

    if (arg.startsWith('--mode=') || arg.startsWith('--session=')) {
      i++
      continue
    }

    out.push(arg)
    i++
  }

  return out
}
