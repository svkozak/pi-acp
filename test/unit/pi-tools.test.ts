import test from "node:test";
import assert from "node:assert/strict";
import { toolResultToText } from "../../src/acp/translate/pi-tools.js";

test("toolResultToText: extracts text from content blocks", () => {
  const text = toolResultToText({
    content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }],
  });
  assert.equal(text, "hello world");
});

test("toolResultToText: falls back to JSON", () => {
  const text = toolResultToText({ a: 1 });
  assert.match(text, /"a": 1/);
});
