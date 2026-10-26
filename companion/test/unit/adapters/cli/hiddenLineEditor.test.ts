import assert from "node:assert/strict";
import { test } from "node:test";
import { HiddenLineEditor } from "../../../../src/adapters/cli/hiddenLineEditor.ts";

test("collects a pasted link until Enter", () => {
  const editor = new HiddenLineEditor();
  assert.equal(editor.feed("http://host/pair#tok"), null);
  assert.equal(editor.feed("en=ABC\r"), "done");
  assert.equal(editor.line, "http://host/pair#token=ABC");
});

test("handles backspace and ignores arrow keys and control characters", () => {
  const editor = new HiddenLineEditor();
  editor.feed("abcx\u007f\u001b[D\u001b[3~\u0001\u0004d\n");
  assert.equal(editor.line, "abcd");
});

test("Ctrl-C cancels, and Ctrl-D cancels on an empty line", () => {
  assert.equal(new HiddenLineEditor().feed("abc\u0003"), "cancelled");
  assert.equal(new HiddenLineEditor().feed("\u0004"), "cancelled");
});
