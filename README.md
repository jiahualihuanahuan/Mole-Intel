# Mole Intel

A web desk for one ticker at a time. Opening a name shows the last note. If there is none, six seats sit: bull, bear, valuation, macro, earnings, and analyst ratings. A judge writes the call and lists what they still do not agree on.

The page shows the company tape (price, multiples, market cap), the headlines those seats read, and the debate. Notes land in `data/debates.jsonl`.

vLLM is not part of this Compose file. Start it yourself on the host, port 8000, model name `qwen3.5-9b`. SearXNG is expected at `192.168.86.35:8099`.

## Run

```bash
git pull
docker compose up --build -d
```

Open `http://127.0.0.1:8090`.

Optional keys, before compose:

```bash
export FRED_API_KEY=...
export FINNHUB_API_KEY=...
docker compose up --build -d
```

## Midnight batch

The `desk` service waits until 00:00 America/Toronto, then runs the same six seats plus the judge across the universe in `src/data/universe.ts`. It writes the same `data/debates.jsonl` the page reads. `BATCH_LIMIT` defaults to 500 so a long list does not collide with the next night. A cursor in `data/batch-cursor.json` continues where the last night stopped.

To run one pass now:

```bash
docker compose run --rm desk node /app/scripts/debate-batch.mjs --limit 5
```
