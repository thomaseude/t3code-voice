// What the voice model is told at the start of a session: its French instructions and the
// tools it may call. Tool names and descriptions are in English; the assistant speaks French.

import type { VoiceTool } from "../ports/voiceEngine.ts";

export const VOICE_TOOLS: VoiceTool[] = [
  {
    name: "list_projects",
    description: "List the user's T3 Code projects by name.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_activity",
    description:
      "List the user's T3 Code tasks with their status, as T3 reports it. " +
      "scope: running = tasks an agent works on now or that wait for the user; " +
      "today = tasks finished (completed or failed) since midnight; " +
      "finished = tasks finished in the last 24 hours.",
    parameters: {
      type: "object",
      properties: { scope: { type: "string", enum: ["running", "today", "finished"] } },
      required: ["scope"],
      additionalProperties: false,
    },
  },
  {
    name: "end_session",
    description:
      'End the voice conversation, when the user says "fin", "c\'est bon, merci" or ' +
      "clearly wants to stop talking. Say a short goodbye first.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

export function voiceInstructions(projectNames: string[]): string {
  const projects =
    projectNames.length === 0
      ? "Aucun projet n'est connu pour l'instant."
      : `Ses projets T3 : ${projectNames.join(", ")}.`;
  return [
    "Tu es l'assistant vocal d'un développeur qui pilote des agents de code (Claude, Codex) sur son serveur T3 Code.",
    "Tu parles français, de façon concise : une ou deux phrases par réponse.",
    "Les termes techniques (branch, commit, merge, worktree, pull request, noms de fichiers et de commandes) restent en anglais, prononcés à l'anglaise.",
    projects,
    "N'invente jamais un statut : ce qui tourne, ce qui est terminé ou a échoué vient uniquement des outils. Si un outil ne répond pas ou dit que T3 est indisponible, dis-le simplement.",
    'Un simple "stop", "tais-toi" ou "attends" veut seulement dire : arrête de parler.',
    'Quand l\'utilisateur dit "fin" ou "c\'est bon, merci", dis au revoir en quelques mots et appelle end_session.',
  ].join("\n");
}
