// Short spoken excerpts of a thread's messages: what the voice model may say aloud. Code,
// paths and links are never read: a code block is named, a path keeps its file name, a link
// keeps its words.

/** The longest excerpt, in characters: about 20 seconds of speech. */
const MAX_EXCERPT_CHARS = 400;

/** The start of `text`, ready to be spoken; `cut` when the rest is left out. */
export function spokenExcerpt(text: string): { excerpt: string; cut: boolean } {
  const spoken = spokenText(text);
  if (spoken.length <= MAX_EXCERPT_CHARS) return { excerpt: spoken, cut: false };
  const start = spoken.slice(0, MAX_EXCERPT_CHARS);
  // Cut between two words, unless that loses too much.
  const lastSpace = start.lastIndexOf(" ");
  const kept = lastSpace > MAX_EXCERPT_CHARS * 0.75 ? start.slice(0, lastSpace) : start;
  return { excerpt: `${kept}…`, cut: true };
}

/** `text` with its Markdown, code, links and paths turned into words, on one line. */
function spokenText(text: string): string {
  return (
    text
      // A code block, closed or not, is named.
      .replace(/```[\s\S]*?(```|$)/g, "\n(bloc de code)\n")
      // A Markdown link keeps its words.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\bhttps?:\/\/\S+/g, "(lien)")
      // A path keeps its file name: "/home/me/app/models/review.rb" gives "review.rb". A word
      // like "and/or" stays: a path starts with "/", "~" or ".", or ends with an extension.
      .replace(
        /(?:[~.]*\/)?(?:[\w.@-]+\/)+([\w@-]+\.\w+|[\w.@-]+)/g,
        (path: string, name: string) => (/^[~./]/.test(path) || /\.\w+$/.test(name) ? name : path),
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
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*|__|(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w)/g, "")
    .trim();
  return heading && words !== "" && !/[.!?:]$/.test(words) ? `${words}.` : words;
}
