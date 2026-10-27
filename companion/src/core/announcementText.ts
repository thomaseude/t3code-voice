// What an announcement says, in French, for the voice model to tell the user.

import type { PushNotification } from "../ports/pushSender.ts";
import type { ThreadError } from "../ports/t3Backend.ts";

/** An event of a followed task, ready to be spoken or pushed. */
export interface Announcement {
  threadId: string;
  /** Which event it is (see eventKeyOf): each one is told once. */
  eventKey: string;
  state: PushNotification["state"];
  spokenName: string;
  project: string | null;
  /** The short summary of a completed run, or null when there is none. */
  summary: string | null;
  /** Why a failed run failed, as T3 reports it. */
  error: ThreadError | null;
}

/** Plain French for T3's failure classes. */
const FAILURE_CAUSES: Record<string, string> = {
  usage_limit: "limite d'utilisation atteinte",
  provider_error: "erreur du fournisseur de l'agent",
  transport_error: "connexion perdue avec le fournisseur de l'agent",
  permission_error: "autorisation refusée",
  validation_error: "requête refusée par le fournisseur de l'agent",
};

/** The sentence spoken for `announcement`; times are given in the device's time zone. */
export function spokenAnnouncement(
  announcement: Announcement,
  timeZone: string,
  now: Date,
): string {
  const { spokenName, project } = announcement;
  const task = project === null ? `«${spokenName}»` : `«${spokenName}» sur ${project}`;
  switch (announcement.state) {
    case "completed":
      return announcement.summary === null
        ? `${task} est terminée.`
        : `${task} est terminée : ${announcement.summary}`;
    case "failed":
      return `${task} a échoué : ${failureOf(announcement.error, timeZone, now)}`;
    case "waiting_for_input":
      return `${task} attend ta réponse.`;
    case "waiting_for_approval":
      return `${task} demande une autorisation.`;
  }
}

function failureOf(error: ThreadError | null, timeZone: string, now: Date): string {
  const failureClass = error?.failureClass ?? "";
  const cause = Object.hasOwn(FAILURE_CAUSES, failureClass)
    ? FAILURE_CAUSES[failureClass]
    : "erreur inconnue";
  if (error === null || error.resumesAt === null) return `${cause}.`;
  const when = spokenTime(new Date(error.resumesAt), timeZone, now);
  return error.autoResume
    ? `${cause}. Elle reprendra toute seule ${when}.`
    : `${cause}. Elle pourra reprendre ${when}.`;
}

/** "à 16 h 00" today, "le 27 octobre à 09 h 30" another day, in `timeZone`. */
function spokenTime(date: Date, timeZone: string, now: Date): string {
  const hour = new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(date)
    .replace(":", " h ");
  const day = new Intl.DateTimeFormat("fr-FR", { timeZone, day: "numeric", month: "long" });
  return day.format(date) === day.format(now) ? `à ${hour}` : `le ${day.format(date)} à ${hour}`;
}
