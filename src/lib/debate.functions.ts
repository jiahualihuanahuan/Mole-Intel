import { createServerFn } from "@tanstack/react-start";
import type { ArchiveHit } from "@/lib/debate-archive";
import type { DebateResult, DeskBoards, DeskRun, FeedReport, Tape } from "@/lib/debate-types";
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

export const readChineseFn = createServerFn({ method: "POST" })
  .validator(tickerOf)
  .handler(async ({ data }) => {
    const { readChinese } = await import("./debate.server");
    return readChinese(data.ticker);
  });

export const startChineseFn = createServerFn({ method: "POST" })
  .validator(tickerOf)
  .handler(async ({ data }) => {
    const { startChinese } = await import("./debate.server");
    return startChinese(data.ticker);
  });

export const startDebateFn = createServerFn({ method: "POST" })
  .validator(tickerOf)
  .handler(async ({ data }): Promise<DeskRun> => {
    const { startDebate } = await import("./debate.server");
    return startDebate(data.ticker);
  });

export const debateRunFn = createServerFn({ method: "POST" })
  .validator(tickerOf)
  .handler(async ({ data }): Promise<DeskRun | null> => {
    const { readDeskRun } = await import("./debate.server");
    return readDeskRun(data.ticker);
  });
