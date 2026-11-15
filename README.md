# Voice Chat — Deepgram Flux + Groq

Talk into your microphone and get written answers. Speech is transcribed by
Deepgram's latest streaming model (**Flux**, `flux-general-en`) and answered by
**`openai/gpt-oss-120b`** on Groq, streamed token by token.

## Run locally

Requires Node 22+.

```bash
npm install
```

```bash
cp .env.example .env
```

Put your `DEEPGRAM_API_KEY` and `GROQ_API_KEY` in `.env`, then:

```bash
npm run dev
```

Open http://localhost:5173 and press **Unmute**. The Vite dev server also runs the
functions in `/api`, so no second process is needed.

## Deploy to Vercel (and use it on your phone)

1. Import this repository at https://vercel.com/new. Vercel detects Vite; keep the defaults.
2. Under **Environment Variables**, add `DEEPGRAM_API_KEY`, `GROQ_API_KEY` and — strongly
   recommended — `APP_PASSWORD`.
3. Deploy, open the URL on your phone, and allow microphone access.

Without `APP_PASSWORD`, anyone who finds the URL can use your Deepgram and Groq credits.
With it, the app asks for the password once per browser and remembers it.

The screen is kept awake while unmuted, because a sleeping phone stops the microphone.
Chats are stored per browser, so your phone and laptop each keep their own list.

## Features

- **Mute / Unmute** — unmute opens the mic and the Deepgram stream; mute releases both.
  Muting mid-sentence still answers what you said so far.
- **Flux / Nova-3 toggle** in the header to compare Deepgram's two speech models. Switching
  while unmuted reconnects on the other model. Each answer is labelled with the model used
  and two latencies, both measured from the end of your last word: when the model declared
  the turn over, and when the first answer token arrived.
- **New chat** and a chat list with delete.
- **System prompt** — editable from the sidebar, applied to every request.
- **Local storage only** — chats and the system prompt live in the browser's
  `localStorage`. There is no database.

## What makes it fast

- The browser streams audio **directly to Deepgram** (`wss://api.deepgram.com/v2/listen`)
  using a 60-second token minted by the server, so audio skips a relay hop and the API
  key stays server-side.
- Audio is 16 kHz `linear16` sent in 80 ms chunks, as Deepgram recommends for Flux.
- **Speculative answers**: Flux's `EagerEndOfTurn` starts the Groq request before the
  turn is confirmed. `TurnResumed` cancels it; `EndOfTurn` keeps it.
- At `StartOfTurn`, while you are still speaking, the app pings `/api/warm` so the
  function instance is awake and its connection to Groq is already open.
- Groq is called with `stream: true`, and its server-sent-event stream is handed to the
  browser untouched, so each token is painted as it is generated.
- Groq is tuned for latency: `reasoning_effort: "low"`, `include_reasoning: false` (no
  reasoning text ahead of the answer), and `service_tier: "auto"` (the fastest tier your
  account has).
- Token fetch, mic permission and worklet load run in parallel on unmute; audio captured
  before the socket opens is queued, so first words are not lost.

## Configuration

| Variable | Default | |
|---|---|---|
| `DEEPGRAM_API_KEY` | — | Needs Member permissions or higher (required by `/v1/auth/grant`). |
| `GROQ_API_KEY` | — | |
| `APP_PASSWORD` | — | If set, required to use the app. Set this on any public deployment. |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | |
| `GROQ_REASONING_EFFORT` | `low` | `low`, `medium` or `high` |
| `HISTORY_TOKEN_BUDGET` | `6000` | Estimated tokens of recent conversation sent each turn. Oldest messages are dropped first; the system prompt is always sent in full. |
| `GROQ_SERVICE_TIER` | `auto` | `auto`, `on_demand`, `flex` or `performance` (enterprise) |

Turn-detection settings are in the `ASR` table at the top of `src/app.js`: Flux uses
`eot_threshold`, `eager_eot_threshold` and `eot_timeout_ms`; Nova-3 uses `endpointing`
(300 ms of silence) and `utterance_end_ms`. Speculative answers are Flux-only, since Nova-3
has no eager end-of-turn signal. For non-English speech, switch the model there to `flux-general-multi`.

## Docs used

- Deepgram Flux: https://developers.deepgram.com/docs/flux/quickstart, https://developers.deepgram.com/docs/flux/state, https://developers.deepgram.com/reference/speech-to-text/listen-flux
- Deepgram Nova-3 streaming: https://developers.deepgram.com/reference/speech-to-text/listen-streaming, https://developers.deepgram.com/docs/understand-endpointing-interim-results
- Deepgram tokens: https://developers.deepgram.com/guides/fundamentals/token-based-authentication
- Groq: https://console.groq.com/docs/model/openai/gpt-oss-120b, https://console.groq.com/docs/reasoning, https://console.groq.com/docs/service-tiers, https://console.groq.com/docs/api-reference
- Vercel Functions streaming: https://vercel.com/docs/functions/streaming-functions
