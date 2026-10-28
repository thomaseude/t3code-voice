// Short spoken excerpts of a thread's messages: what the voice model may say aloud. Code,
// paths and links are never read: a code block is named, a path keeps its file name, a link
// keeps its words.

/** The longest excerpt, in characters: about 20 seconds of speech. */
const MAX_EXCERPT_CHARS = 400;

/**
 * How much of a message, once its code blocks are named, the excerpt is made from. Enough
 * for 400 spoken characters, and small enough that the regexes below stay quick.
 */
const MAX_SOURCE_CHARS = 4_000;

const CODE_BLOCK = "(bloc de code)";

/** A Markdown list item's marker and the spaces after it: "- un", "* un", "1. un", "2) deux". */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** The start of `text`, ready to be spoken; `cut` when the rest is left out. */
export function spokenExcerpt(text: string): { excerpt: string; cut: boolean } {
  const source = withoutCodeBlocks(text);
  const spoken = spokenText(source.slice(0, MAX_SOURCE_CHARS));
  if (spoken.length <= MAX_EXCERPT_CHARS) {
    if (source.length <= MAX_SOURCE_CHARS) return { excerpt: spoken, cut: false };
    return { excerpt: `${spoken}…`, cut: true };
  }
  const start = spoken.slice(0, MAX_EXCERPT_CHARS);
  // Cut between two words, unless that loses too much.
  const lastSpace = start.lastIndexOf(" ");
  const kept = lastSpace > MAX_EXCERPT_CHARS * 0.75 ? start.slice(0, lastSpace) : start;
  return { excerpt: `${kept}…`, cut: true };
}

/**
 * `text` with each Markdown code block replaced by CODE_BLOCK: a block fenced with ``` or ~~~
 * (closed or not), and a block of lines indented by 4 spaces more than the text they belong
 * to, at the start or after an empty line. Inside a list, that text starts after the item's
 * marker: "1. Lance :" then 4 spaces is a second paragraph of the item, 7 spaces is code.
 */
function withoutCodeBlocks(text: string): string {
  const unfenced = text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, `\n${CODE_BLOCK}\n`);
  const lines: string[] = [];
  let inBlock = false;
  // Where the text of the current list item starts, or 0 outside a list.
  let textColumn = 0;
  for (const line of unfenced.split("\n")) {
    const indent = (line.match(/^[ \t]*/)?.[0] ?? "").replace(/\t/g, "    ").length;
    const afterBreak = lines.length === 0 || lines.at(-1)?.trim() === "";
    const code = indent >= textColumn + 4 && (inBlock || afterBreak);
    if (code && line.trim() !== "") {
      if (!inBlock) lines.push(CODE_BLOCK);
      inBlock = true;
      continue;
    }
    // A named code block keeps the list it was in.
    if (line.trim() !== "" && line.trim() !== CODE_BLOCK) {
      inBlock = false;
      const item = line.match(LIST_ITEM);
      if (item !== null) textColumn = item[0].replace(/\t/g, "    ").length;
      else if (indent === 0) textColumn = 0;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** `text` with its Markdown, links and paths turned into words, on one line. */
function spokenText(text: string): string {
  return (
    text
      // A Markdown link keeps its words.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // A bare link is named; a bracket or a full stop after it is not part of it.
      .replace(/\bhttps?:\/\/[^\s)\]>]*[^\s)\]>.,;:!?]/g, "(lien)")
      // A path keeps its file name: "/home/me/app/models/review.rb", "C:\Users\me\main.ts"
      // or "src\core\main.ts" give their last part. Words like "and/or" or numbers like
      // "1.5/2.0" stay: a path starts with a drive, "/", "\", "~" or ".", or ends with an
      // extension that starts with a letter.
      .replace(
        /(?:\b[A-Za-z]:)?(?:[~.]*[\\/]+)?(?:[\w.@-]+(?:\\\\|[\\/]))+([\w@-]+\.[A-Za-z]\w*|[\w.@-]+)/g,
        (path: string, name: string) =>
          /^(?:[A-Za-z]:|[~./\\])/.test(path) || /\.[A-Za-z]\w*$/.test(name) ? name : path,
      )
      .replace(/`([^`]*)`/g, "$1")
      .split("\n")
      .map(spokenLine)
      .filter((line) => line !== "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** One line with no Markdown marks; a heading ends with a full stop, to be heard as one. */
function spokenLine(line: string): string {
  const heading = /^\s*#+\s+/.test(line);
  const words = line
    .replace(/^\s*#+\s+/, "")
    .replace(LIST_ITEM, "")
    .replace(/\*\*|__|(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w)/g, "")
    .trim();
  return heading && words !== "" && !/[.!?:]$/.test(words) ? `${words}.` : words;
}
