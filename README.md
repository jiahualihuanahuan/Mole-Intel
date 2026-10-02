# Mole Intel

Nasdaq 100 first, then the rest of the S&P 500. For each company, Mole Intel checks the latest investor-relations wire or news item and sets it beside the SEC filing.

Source judgment is written by your local OpenAI-compatible model. The browser calls that address directly, so the model stays on your machine even when the desk runs in Docker. llama.cpp is usually `http://127.0.0.1:8080/v1`. Ollama is usually `http://127.0.0.1:11434/v1`. A headline is still not a figure.

## Run

```bash
docker compose up --build
```

Open `http://127.0.0.1:8090`. The desk uses port 8090 so it does not take the port your local model is already using.

Universe: 101 Nasdaq-100 names, then S&P 500 names that are not already in the Nasdaq 100.
