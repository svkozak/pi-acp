import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePiAssistantText,
  normalizePiMessageText,
} from "../../src/acp/translate/pi-messages.js";

test("normalizePiMessageText: supports string", () => {
  assert.equal(normalizePiMessageText("hello"), "hello");
});

test("normalizePiMessageText: joins text blocks", () => {
  assert.equal(
    normalizePiMessageText([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "not_text", x: 1 },
    ]),
    "ab",
  );
});

test("normalizePiAssistantText: joins only text blocks", () => {
  assert.equal(
    normalizePiAssistantText([
      { type: "text", text: "hi" },
      { type: "thinking", text: "..." },
      { type: "text", text: "!" },
    ]),
    "hi!",
  );
});
