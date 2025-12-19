export function toolResultToText(result: unknown): string {
  if (!result) return "";

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content;
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) =>
        c?.type === "text" && typeof c.text === "string" ? c.text : "",
      )
      .filter(Boolean);
    if (texts.length) return texts.join("");
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
