// Project folders a voice start just gave an agent. T3's shell shows the new thread a
// moment after the launch; until then, a second start must see the folder as busy, or two
// agents would work in the same checkout.

import type { Clock } from "../ports/clock.ts";
import type { ShellState } from "./shellState.ts";

/** How long a claim lasts after T3 answered the launch, when the shell does not show the thread. */
const CLAIM_AFTER_LAUNCH_MS = 30_000;

/** One launch's hold on a project folder. A shared start can add a second one to the same folder. */
export interface FolderClaim {
  projectId: string;
  /** Null while T3 has not answered the launch: the claim then never ends by itself. */
  threadId: string | null;
  launchedAt: number | null;
}

export class FolderClaims {
  private readonly clock: Clock;
  private readonly claims = new Set<FolderClaim>();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Whether a start holds the project's folder. A claim ends once the shell shows its thread. */
  isClaimed(projectId: string, shell: ShellState): boolean {
    let claimed = false;
    for (const claim of this.claims) {
      if (claim.projectId !== projectId) continue;
      if (
        claim.threadId !== null &&
        claim.launchedAt !== null &&
        (shell.threads.has(claim.threadId) ||
          this.clock.now() - claim.launchedAt > CLAIM_AFTER_LAUNCH_MS)
      ) {
        this.claims.delete(claim);
      } else {
        claimed = true;
      }
    }
    return claimed;
  }

  claim(projectId: string): FolderClaim {
    const claim = { projectId, threadId: null, launchedAt: null };
    this.claims.add(claim);
    return claim;
  }

  /** T3 started the thread: the claim lasts until the shell shows it, 30 s at most. */
  launched(claim: FolderClaim, threadId: string): void {
    claim.threadId = threadId;
    claim.launchedAt = this.clock.now();
  }

  /** The launch failed: its claim on the folder ends. */
  release(claim: FolderClaim): void {
    this.claims.delete(claim);
  }
}
