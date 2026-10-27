// Spoken names: the short French name the user calls a followed task by ("tests Reviews"),
// and how a spoken reference ("la tâche des tests reviews") finds the task again.

/** Small words that never tell two tasks apart: articles, prepositions, "tâche". */
const STOP_WORDS = new Set([
  "a",
  "au",
  "aux",
  "avec",
  "ce",
  "cet",
  "cette",
  "d",
  "dans",
  "de",
  "des",
  "du",
  "en",
  "et",
  "l",
  "la",
  "le",
  "les",
  "ou",
  "par",
  "pour",
  "puis",
  "sur",
  "tache",
  "taches",
  "un",
  "une",
]);

const MIN_WORDS = 2;
const MAX_WORDS = 4;
/** Words a name made from the request keeps. */
const FALLBACK_WORDS = 3;

export interface SpokenNameRequest {
  /** The name the voice model proposed, or null. */
  proposed: string | null;
  /** The text the name is made from when the proposal is not valid: the request or the thread title. */
  source: string;
  /** The project's title, added when the name is taken or too short. */
  project: string;
  /** Names of the tasks already followed. */
  taken: string[];
}

/**
 * The proposal when it has 2 to 4 words, otherwise the first meaningful words of the
 * source. A name already taken gets the project's name, then an ordinal ("… 2").
 */
export function chooseSpokenName({ proposed, source, project, taken }: SpokenNameRequest): string {
  const proposedWords = (proposed ?? "").split(/\s+/).map(trimPunctuation).filter(Boolean);
  const name =
    proposedWords.length >= MIN_WORDS && proposedWords.length <= MAX_WORDS
      ? proposedWords.join(" ")
      : nameFrom(source, project);

  // Two names that findByName cannot tell apart count as the same name.
  const takenKeys = new Set(taken.map(spokenKey));
  if (!takenKeys.has(spokenKey(name))) return name;
  const withProject = `${name} ${project}`;
  if (!takenKeys.has(spokenKey(withProject))) return withProject;
  for (let ordinal = 2; ; ordinal++) {
    const candidate = `${name} ${ordinal}`;
    if (!takenKeys.has(spokenKey(candidate))) return candidate;
  }
}

/** What findByName compares: the meaningful words, without order, plurals or accents. */
function spokenKey(name: string): string {
  return [...meaningfulStems(name)].sort().join(" ");
}

export type NameMatch<T> =
  | { kind: "found"; item: T }
  /** Several items fit: the caller must ask which one, and act on none. */
  | { kind: "ambiguous"; items: T[] }
  | { kind: "none" };

/**
 * Finds the item a spoken reference names. Case, accents, plurals and small words do not
 * count. An item whose name has exactly the reference's words wins; otherwise every item
 * whose name contains them all fits.
 */
export function findByName<T>(
  query: string,
  items: T[],
  nameOf: (item: T) => string,
): NameMatch<T> {
  const wanted = meaningfulStems(query);
  if (wanted.size === 0) return { kind: "none" };
  const fitting = items.filter((item) => isSubset(wanted, meaningfulStems(nameOf(item))));
  const exact = fitting.filter((item) => meaningfulStems(nameOf(item)).size === wanted.size);
  const best = exact.length > 0 ? exact : fitting;
  if (best.length === 0) return { kind: "none" };
  const [only] = best;
  if (best.length === 1 && only !== undefined) return { kind: "found", item: only };
  return { kind: "ambiguous", items: best };
}

/** Compares names as said: no case, no accents, single spaces. */
export function keyOf(text: string): string {
  return wordsOf(text).join(" ");
}

function nameFrom(source: string, project: string): string {
  const words = source
    .split(/[\s,;:.!?()"«»'’]+/)
    .map(trimPunctuation)
    .filter((word) => word !== "" && !STOP_WORDS.has(plain(word)))
    .slice(0, FALLBACK_WORDS);
  const [first, ...rest] = words;
  if (first === undefined) return `tâche ${project}`;
  // Only the request's first word is capitalized for being first: lower it.
  const named = [/^\p{Lu}\p{Ll}*$/u.test(first) ? first.toLowerCase() : first, ...rest];
  return named.length >= MIN_WORDS ? named.join(" ") : `${named.join(" ")} ${project}`;
}

function meaningfulStems(text: string): Set<string> {
  return new Set(
    wordsOf(text)
      .filter((word) => !STOP_WORDS.has(word))
      .map((word) => (word.length > 3 ? word.replace(/[sx]$/, "") : word)),
  );
}

/** Lowercase words without accents or punctuation; "l'accueil" gives "l" and "accueil". */
function wordsOf(text: string): string[] {
  return plain(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function trimPunctuation(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function isSubset(small: Set<string>, large: Set<string>): boolean {
  for (const word of small) if (!large.has(word)) return false;
  return true;
}
