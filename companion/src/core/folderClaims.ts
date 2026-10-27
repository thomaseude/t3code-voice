// Project folders a voice start just gave an agent. T3's shell shows the new thread a
// moment after the launch; until then, a second start must see the folder as busy, or two
// agents would work in the same checkout.

import type { Clock } from "../ports/clock.ts";
import type { ShellState } from "./shellState.ts";

/** How long a claim lasts after T3 answered the launch, when the shell does not show the thread. */
const CLAIM_AFTER_LAUNCH_MS = 30_000;

interface Claim {
  /** Null while T3 has not answered the launch: the claim then never ends by itself. */
  threadId: string | null;
  launchedAt: number | null;
}

export class FolderClaims {
  private readonly clock: Clock;
  private readonly claims = new Map<string, Claim>();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Whether a start holds the project's folder. A claim ends once the shell shows its thread. */
  isClaimed(projectId: string, shell: ShellState): boolean {
    const claim = this.claims.get(projectId);
    if (claim === undefined) return false;
    if (
      claim.threadId !== null &&
      claim.launchedAt !== null &&
      (shell.threads.has(claim.threadId) ||
        this.clock.now() - claim.launchedAt > CLAIM_AFTER_LAUNCH_MS)
    ) {
      this.claims.delete(projectId);
      return false;
    }
    return true;
  }

  claim(projectId: string): void {
    this.claims.set(projectId, { threadId: null, launchedAt: null });
  }

  /** T3 started the thread: the claim lasts until the shell shows it. */
  launched(projectId: string, threadId: string): void {
    this.claims.set(projectId, { threadId, launchedAt: this.clock.now() });
  }

  /** The launch failed: the folder is free again. */
  release(projectId: string): void {
    this.claims.delete(projectId);
  }
}
