# Mole Intel

A web desk for one ticker at a time. Opening a name shows the last note. If there is none, six seats sit: bull, bear, valuation, earnings, analyst ratings, and news. The news seat is the only one who reads the headlines. The judge reads the macro prints directly. It writes the call and lists what the seats still do not agree on.

The page shows the company tape (price, multiples, market cap), the headlines those seats read, and the debate. Notes land in `data/debates.jsonl`.

Ollama is not part of this Compose file. It should already be running at `192.168.86.35:11434`, model `qwen3.5:9b`. Seats are sent two at a time. Each reply is capped at 4,096 tokens and the prompt is cut to stay inside a 65,536-token window. SearXNG is expected at `192.168.86.35:8099`.

Mole-Intel-Debate is merged here. Do not start an Ollama service from that repo.

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

## 11pm batch

The `desk` service waits until 23:00 America/Toronto, then runs the same seats plus the judge on every developed-world name. It does not stop after 500, and it does not set a GPU power limit. The list is `src/data/universe.ts` (MSCI World, from iShares URTH holdings as of Oct 06, 2026, stored as Yahoo symbols). Notes land in the same `data/debates.jsonl` the page reads. One night is one full pass. A run that is still going at the next 11pm finishes first, then waits for the night after. Set `BATCH_LIMIT` in the desk service only if you want a shorter night; leave it unset for the whole list.

Start the site and the desk together:

```bash
git pull
docker compose up --build -d
```

Ollama still has to be listening at `192.168.86.35:11434` before 11pm. Watch the wait with `docker compose logs -f desk`.

To run a short pass now, without waiting for 11pm:

```bash
docker compose run --rm desk node /app/scripts/debate-batch.mjs --limit 5
```
