# Mole Intel

Nasdaq 100 first, then the rest of the S&P 500. For each company, Mole Intel checks the latest investor-relations wire or news item and sets it beside the SEC filing.

Source judgment is written by Ollama at `http://192.168.86.35:11434/v1`, model `qwen3.5:9b`. The browser calls that address directly. On the Ollama machine, set `OLLAMA_ORIGINS=*` and restart Ollama so the desk is allowed to ask. A headline is still not a figure.

## Run

```bash
docker compose up --build
```

Open `http://127.0.0.1:8090`. The desk uses port 8090 so it does not take the port your local model is already using.

Universe: 101 Nasdaq-100 names, then S&P 500 names that are not already in the Nasdaq 100.
