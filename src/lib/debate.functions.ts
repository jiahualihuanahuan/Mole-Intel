import { createServerFn } from "@tanstack/react-start";
import type { ArchiveHit } from "@/lib/debate-archive";
import type { DebateResult, Tape } from "@/lib/debate-types";

function tickerOf(input: { ticker: string }): { ticker: string } {
  const ticker = String(input?.ticker ?? "").trim().toUpperCase();
  if (!/^[A-Z.]{1,8}$/.test(ticker)) throw new Error("Enter a ticker, like NVDA.");
  return { ticker };
}

export const readTapeFn = createServerFn({ method: "POST" })
  .validator(tickerOf)
  .handler(async ({ data }): Promise<Tape> => {
    const { readTape } = await import("./debate.server");
    return readTape(data.ticker);
  });

export const listArchiveFn = createServerFn({ method: "POST" })
  .validator(() => ({}))
  .handler(async (): Promise<ArchiveHit[]> => {
    const { listArchive } = await import("./debate.server");
    return listArchive();
  });

export const loadArchiveFn = createServerFn({ method: "POST" })
  .validator(tickerOf)
  .handler(async ({ data }): Promise<DebateResult | null> => {
    const { loadArchived } = await import("./debate.server");
    return loadArchived(data.ticker);
  });

export const runDebateFn = createServerFn({ method: "POST" })
  .validator(tickerOf)
  .handler(async ({ data }): Promise<DebateResult> => {
    const { runDebate } = await import("./debate.server");
    return runDebate(data.ticker);
  });
