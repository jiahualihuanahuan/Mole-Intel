# Mole Intel

A web desk for one ticker at a time. Opening a name shows the last note. If there is none, seven seats sit: bull, bear, valuation, macro, earnings, analyst ratings, and news. The news seat is the only one who reads the headlines. It summarizes them and says how they change the company's fundamentals. A judge writes the call and lists what they still do not agree on.

The page shows the company tape (price, multiples, market cap), the headlines those seats read, and the debate. Notes land in `data/debates.jsonl`.

vLLM is not part of this Compose file. Start it yourself on the host, port 8000, model name `qwen3.5-4b-awq`. SearXNG is expected at `192.168.86.35:8099`.

Mole-Intel-Debate is merged here. Do not start a vLLM service from that repo.

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

vLLM still has to be listening on the host at port 8000 before 11pm. Watch the wait with `docker compose logs -f desk`.

To run a short pass now, without waiting for 11pm:

```bash
docker compose run --rm desk node /app/scripts/debate-batch.mjs --limit 5
```
