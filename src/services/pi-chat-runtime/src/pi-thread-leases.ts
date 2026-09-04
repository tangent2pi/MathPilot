import type { PiPrincipal } from "./pi-thread-store.ts";

const principalKey = (principal: PiPrincipal): string =>
  `${principal.tenantId}\u0000${principal.userId}`;

type Lease = { principalKey: string; count: number };

/** Prevents two principals from changing the host-principal file while Pi is
 * executing a turn. Re-entrant leases are allowed for the same principal so a
 * queued follow-up does not deadlock the active session. */
export class PiThreadLeaseRegistry {
  readonly #active = new Map<string, Lease>();

  acquire(threadId: string, principal: PiPrincipal): (() => void) | undefined {
    const key = principalKey(principal);
    const current = this.#active.get(threadId);
    if (current && current.principalKey !== key) return undefined;
    const lease = current ?? { principalKey: key, count: 0 };
    lease.count += 1;
    this.#active.set(threadId, lease);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const active = this.#active.get(threadId);
      if (!active || active.principalKey !== key) return;
      active.count -= 1;
      if (active.count <= 0) this.#active.delete(threadId);
    };
  }

  clear(): void {
    this.#active.clear();
  }
}
