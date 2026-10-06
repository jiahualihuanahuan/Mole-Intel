# Mole Intel

A company desk for the Nasdaq 100 and the S&P 500. Pick a name, read the tape, then sit six seats on it.

The tape is the last price, the day move, the three-month return, and the latest Yahoo Finance headlines. Nothing else is fetched. Bull, bear, valuation, macro, earnings, and analyst each write a memo from that packet. The judge calls bullish, bearish, neutral, or mixed, and writes the disagreement instead of forcing a side. If a multiple, a rating, or a macro print is not on the tape, the seat says it is unknown.

Notes stay in this browser. Sitting the desk again replaces the saved note.

## Run

```bash
npm install
npm run dev
```

The desk model is `grok-4.5` through the xAI API. Set `XAI_API_KEY` in the environment before sitting the desk.
