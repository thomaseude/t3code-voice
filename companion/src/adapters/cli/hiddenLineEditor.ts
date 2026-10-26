// Turns raw terminal keystrokes into one hidden line (used to read the pairing link).

export type EditorResult = "done" | "cancelled" | null;

export class HiddenLineEditor {
  line = "";
  private inEscapeSequence = false;

  /** Feeds typed characters. Returns "done" on Enter, "cancelled" on Ctrl-C, else null. */
  feed(chunk: string): EditorResult {
    for (const char of chunk) {
      if (this.inEscapeSequence) {
        // Arrow and function keys send ESC [ ... ending with a letter or "~": ignore them.
        if (/[A-Za-z~]/.test(char)) this.inEscapeSequence = false;
        continue;
      }
      if (char === "\r" || char === "\n") return "done";
      if (char === "\u0003") return "cancelled";
      if (char === "\u0004" && this.line === "") return "cancelled"; // Ctrl-D on an empty line
      if (char === "\u001b") this.inEscapeSequence = true;
      else if (char === "\u007f" || char === "\b") this.line = this.line.slice(0, -1);
      else if (char >= " ") this.line += char; // other control characters are ignored
    }
    return null;
  }
}
