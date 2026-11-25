import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'

export type FormMethod = 'select' | 'confirm' | 'input' | 'editor'

export type ExtensionUiForm = {
  request: CreateElicitationRequest
  // Reads the pi response payload out of an accepted form, or null if the answer is unusable.
  answer: (content: Record<string, unknown> | null | undefined) => ExtensionUiAnswer | null
}

export type ExtensionUiAnswer = { value: string } | { confirmed: boolean }

const FIELD = 'value'

function str(ev: Record<string, unknown>, key: string): string | null {
  const v = ev[key]
  return typeof v === 'string' ? v : null
}

function formMessage(ev: Record<string, unknown>, fallback: string): string {
  const title = str(ev, 'title')
  const message = str(ev, 'message')
  if (title && message) return `${title}\n\n${message}`
  return title ?? message ?? fallback
}

/**
 * Build an ACP form elicitation for a pi extension dialog, or null when the dialog
 * can't be expressed as a form (the caller then falls back to the permission bridge).
 */
export function buildExtensionUiForm(
  sessionId: string,
  method: string,
  ev: Record<string, unknown>
): ExtensionUiForm | null {
  const scope = { mode: 'form' as const, sessionId }
  const schema = (properties: Record<string, unknown>, required: boolean) =>
    ({
      type: 'object',
      properties,
      ...(required ? { required: [FIELD] } : {})
    }) as Extract<CreateElicitationRequest, { mode: 'form' }>['requestedSchema']

  if (method === 'select') {
    const options = Array.isArray(ev.options) ? ev.options.map(o => String(o)) : []
    if (!options.length || new Set(options).size !== options.length) return null

    return {
      request: {
        ...scope,
        message: formMessage(ev, 'Pi select'),
        requestedSchema: schema(
          { [FIELD]: { type: 'string', oneOf: options.map(o => ({ const: o, title: o })) } },
          true
        )
      },
      answer: content => {
        const v = content?.[FIELD]
        return typeof v === 'string' && options.includes(v) ? { value: v } : null
      }
    }
  }

  if (method === 'confirm') {
    return {
      request: {
        ...scope,
        message: formMessage(ev, 'Pi confirm'),
        requestedSchema: schema({ [FIELD]: { type: 'boolean' } }, true)
      },
      answer: content => {
        const v = content?.[FIELD]
        return typeof v === 'boolean' ? { confirmed: v } : null
      }
    }
  }

  if (method === 'input' || method === 'editor') {
    const placeholder = str(ev, 'placeholder')
    const prefill = str(ev, 'prefill')

    return {
      request: {
        ...scope,
        message: formMessage(ev, `Pi ${method}`),
        requestedSchema: schema(
          {
            [FIELD]: {
              type: 'string',
              ...(placeholder ? { description: placeholder } : {}),
              ...(prefill !== null ? { default: prefill } : {})
            }
          },
          false
        )
      },
      // An empty submission is a real answer, so a missing field reads as "".
      answer: content => {
        const v = content?.[FIELD]
        if (v === undefined || v === null) return { value: '' }
        return typeof v === 'string' ? { value: v } : null
      }
    }
  }

  return null
}
