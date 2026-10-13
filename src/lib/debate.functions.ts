import { createServerFn } from "@tanstack/react-start";
import type { ArchiveHit } from "@/lib/debate-archive";
import type { DebateResult, DeskBoards, FeedReport, Tape } from "@/lib/debate-types";
import { normalizeYahooTicker } from "@/lib/yahoo-ticker.mjs";

function tickerOf(input: { ticker: string }): { ticker: string } {
  return { ticker: normalizeYahooTicker(String(input?.ticker ?? "")) };
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

export const readBoardsFn = createServerFn({ method: "POST" })
  .validator(() => ({}))
  .handler(async (): Promise<DeskBoards> => {
    const { readBoards } = await import("./debate.server");
    return readBoards();
  });

export const readFeedsFn = createServerFn({ method: "POST" })
  .validator(tickerOf)
  .handler(async ({ data }): Promise<FeedReport> => {
    const { readFeeds } = await import("./debate.server");
    return readFeeds(data.ticker);
  });

export const runDebateFn = createServerFn({ method: "POST" })
  .validator(tickerOf)
  .handler(async ({ data }): Promise<DebateResult> => {
    const { runDebate } = await import("./debate.server");
    return runDebate(data.ticker);
  });
