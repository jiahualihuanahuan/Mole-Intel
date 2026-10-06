# Mole Intel

A company desk for the Nasdaq 100 and the S&P 500. Finished debates are read from `~/Mole-Intel-Debate/data/debates.jsonl`. A new pass talks to vLLM on the 3080. No xAI key.

## Run

vLLM should already be serving `qwen2.5-7b` on port 8000. Then:

```bash
cd Mole-Intel
git pull
docker compose up --build -d
```

Open `http://127.0.0.1:8090`. The home page lists every ticker in the archive. Opening one shows that note. **Run it again on the 3080** appends a new line to the same file.

If the model name differs, set `LLM_MODEL` in a `.env` file next to the compose file. Compose loads it only when you add `env_file`; the defaults above are already in `docker-compose.yml`.
