# Mole Intel

A company desk for the Nasdaq 100 and the S&P 500. Pick a name, read the tape, then sit six seats on it.

The tape is the last price, the day move, the three-month return, and the latest Yahoo Finance headlines. Nothing else is fetched. Bull, bear, valuation, macro, earnings, and analyst each write a memo from that packet. The judge calls bullish, bearish, neutral, or mixed, and writes the disagreement instead of forcing a side. If a multiple, a rating, or a macro print is not on the tape, the seat says it is unknown.

Notes stay in this browser. Sitting the desk again replaces the saved note.

## Run

```bash
git pull
cp .env.example .env
```

Put an xAI API key in `.env` as `XAI_API_KEY=...`, then:

```bash
docker compose up --build -d
```

Open `http://127.0.0.1:8090`. The first build installs dependencies and compiles the server. Later starts reuse the image until the code changes.

```bash
docker compose logs -f
docker compose down
```
