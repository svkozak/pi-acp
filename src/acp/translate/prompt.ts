import type { ContentBlock } from "@agentclientprotocol/sdk";

export type PiAttachment = {
  id: string;
  type: "image" | "document";
  fileName: string;
  mimeType: string;
  size: number;
  content: string;
  extractedText?: string;
  preview?: string;
};

export function guessFileNameFromMime(mimeType: string): string {
  const ext =
    mimeType === "image/png"
      ? "png"
      : mimeType === "image/jpeg"
        ? "jpg"
        : mimeType === "image/webp"
          ? "webp"
          : "bin";
  return `attachment.${ext}`;
}

export function promptToPiMessage(blocks: ContentBlock[]): {
  message: string;
  attachments: PiAttachment[];
} {
  let message = "";
  const attachments: PiAttachment[] = [];

  for (const b of blocks) {
    switch (b.type) {
      case "text":
        message += b.text;
        break;

      case "resource_link":
        message += `\n[Context] ${b.uri}`;
        break;

      case "image": {
        const id = b.uri ?? crypto.randomUUID();
        // pi expects base64 without data-url prefix.
        const size = Buffer.byteLength(b.data, "base64");
        attachments.push({
          id,
          type: "image",
          fileName: guessFileNameFromMime(b.mimeType),
          mimeType: b.mimeType,
          size,
          content: b.data,
        });
        break;
      }

      // Not supported in pi-acp MVP.
      case "audio":
      case "resource":
        break;

      default:
        break;
    }
  }

  return { message, attachments };
}
