# Mole Intel

One desk. Opening a ticker shows its note from `~/Mole-Intel-Debate/data/debates.jsonl`. If that ticker has never been run, the page starts the debate: prices and multiples from Yahoo, headlines from SearXNG, then six seats and a judge on vLLM. The result is appended to the same file.

## Run

vLLM should already be serving `qwen2.5-7b` on port 8000, and SearXNG on port 8099.

```bash
cd Mole-Intel
git pull
docker compose up --build -d
```

Open `http://127.0.0.1:8090`. Optional keys, if you have them, go in the shell before compose:

```bash
export FRED_API_KEY=...
export FINNHUB_API_KEY=...
docker compose up --build -d
```
