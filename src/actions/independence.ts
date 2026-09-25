import type { ProgressRecord, TicketRecord, TicketsRecord } from "../project/records.js";

/**
 * When a ticket may start beside parked ones (D30, issue #12): never when
 * it depends, directly or not, on a parked ticket, and otherwise only with
 * a recorded independence check that covers every ticket parked now. Shared
 * by `implement start` and `implement next`, so neither can skip it.
 */

export function parkedTickets(tickets: TicketsRecord, except?: string): readonly TicketRecord[] {
  return tickets.tickets.filter((ticket) => ticket.status === "parked" && ticket.id !== except);
}

/** The parked ticket `ticketId` depends on, directly or through other tickets, if any. */
export function parkedDependency(tickets: TicketsRecord, ticketId: string): string | undefined {
  const byId = new Map(tickets.tickets.map((ticket) => [ticket.id, ticket]));
  const seen = new Set<string>();
  const queue = [...(byId.get(ticketId)?.dependsOn ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const dependency = byId.get(id);
    if (dependency?.status === "parked") return id;
    queue.push(...(dependency?.dependsOn ?? []));
  }
  return undefined;
}

/** The uncommitted paths recorded as the given parked tickets' partial edits. */
export function partialEdits(progress: ProgressRecord, parkedIds: readonly string[]): readonly string[] {
  return (progress.changeOwnership ?? [])
    .filter((entry) => entry.owner === "ticket" && parkedIds.includes(entry.ticketId))
    .map((entry) => entry.path)
    .sort();
}

/** Why `ticketId` may not start beside the parked tickets, or undefined when it may. */
export function independenceGap(tickets: TicketsRecord, progress: ProgressRecord, ticketId: string): string | undefined {
  const parked = parkedTickets(tickets, ticketId);
  if (parked.length === 0) return undefined;
  const blocker = parkedDependency(tickets, ticketId);
  if (blocker !== undefined) return `ticket ${ticketId} depends on parked ticket ${blocker}, so it waits for it`;
  const checked = progress.independenceChecks?.[ticketId]?.parked ?? [];
  const unchecked = parked.filter((ticket) => !checked.includes(ticket.id)).map((ticket) => ticket.id);
  if (unchecked.length === 0) return undefined;
  return `ticket ${ticketId} has no recorded independence check against parked ${unchecked.join(", ")}; record one before it starts beside a parked ticket`;
}
