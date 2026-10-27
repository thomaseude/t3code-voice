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
    name: "start_task",
    description:
      "Start a new T3 Code task now: a new thread where an agent works on the user's request. " +
      "The companion picks the folder: a new worktree when the project's folder is busy or the " +
      "project uses worktrees. Read back what it answers: agent, model, project, request, " +
      "and the task's spoken name. The task is followed: its news will be announced. " +
      "status ambiguous_project: ask which folder the user means, then call again with folder. " +
      "status ambiguous_model: ask which model, then call again with its agent and model.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project's name, as the user said it." },
        prompt: {
          type: "string",
          description: "The request for the agent, in the user's words and language.",
        },
        agent: {
          type: "string",
          description: 'The agent the user named ("Claude", "Codex"); omit for the default.',
        },
        model: { type: "string", description: "The model the user named; omit for the default." },
        runtime_mode: {
          type: "string",
          enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
          description: "Only when the user asks for one; omit for the default.",
        },
        workspace: {
          type: "string",
          enum: ["new_worktree"],
          description: "Only when the user asks for a new worktree.",
        },
        folder: {
          type: "string",
          description: "The folder the user chose after an ambiguous_project answer.",
        },
        spoken_name: {
          type: "string",
          description:
            'A short French name for the task, 2 to 4 words from the request, e.g. "tests Reviews".',
        },
      },
      required: ["project", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "Send a follow-up message to a followed task, in the same thread, so the agent keeps " +
      "its context. mode queue (default): after the agent's current turn. mode steer: now, " +
      'into its current turn; only when the user says "tout de suite" or "maintenant". ' +
      "Read back the task and the message.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task's spoken name, as the user said it." },
        message: { type: "string", description: "The message, in the user's words." },
        mode: { type: "string", enum: ["queue", "steer"] },
      },
      required: ["task", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_last_action",
    description:
      'Undo the last start_task or send_message, when the user says "non, arrête" or ' +
      '"annule" right after its read-back (within a minute). A started task is stopped and ' +
      "archived; a waiting message is taken back.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "follow_thread",
    description:
      "Follow a T3 thread, also one started from the T3 app, so its news is announced. " +
      "task is its title or part of it, as get_activity gives it.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        spoken_name: {
          type: "string",
          description: "A short French name for the task, 2 to 4 words from its title.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "unfollow_thread",
    description: "Stop following a task: its news is no longer announced.",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "The task's spoken name." } },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "get_task_details",
    description:
      "Details on a task: its status, as T3 reports it, and a longer summary of " +
      "what the agent did in its last finished run (null while it runs). For a failure, " +
      "its cause and when the run can resume.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "A followed task's spoken name, or the title of any thread, as get_activity gives it.",
        },
      },
      required: ["task"],
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
    "Après start_task ou send_message, relis toujours ce qui a été fait : pour un lancement, l'agent, le modèle, le projet, la demande et le nom de la tâche ; pour un message, la tâche et le message.",
    'Si l\'utilisateur dit "non, arrête" ou "annule" juste après cette relecture, appelle cancel_last_action.',
    "Le compagnon t'envoie les nouvelles des tâches suivies (terminée, échouée, attend une réponse ou une autorisation) : dis-les telles quelles, sans en changer le statut. Si l'utilisateur veut en savoir plus, appelle get_task_details.",
    "Appelle les tâches par leur nom court. Quand un outil renvoie plusieurs choix, lis-les et demande lequel ; ne choisis jamais à la place de l'utilisateur. S'il répond par une position (« la deuxième »), rappelle l'outil avec le nom à cette position.",
    'Quand l\'utilisateur dit "fin" ou "c\'est bon, merci", dis au revoir en quelques mots et appelle end_session.',
  ].join("\n");
}
