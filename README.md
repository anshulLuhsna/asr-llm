# Voice Chat — Deepgram Flux + Groq

Talk into your microphone and get written answers. Speech is transcribed by
Deepgram's latest streaming model (**Flux**, `flux-general-en`) and answered by
**`openai/gpt-oss-120b`** on Groq, streamed token by token.

## Run

Requires Node 22.9+. There are no dependencies to install.

```bash
cp .env.example .env
```

Put your `DEEPGRAM_API_KEY` and `GROQ_API_KEY` in `.env`, then:

```bash
npm start
```

Open http://localhost:3000 and press **Unmute**.

## Features

- **Mute / Unmute** — unmute opens the mic and the Deepgram stream; mute releases both.
  Muting mid-sentence still answers what you said so far.
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
- The server holds a keep-alive connection to Groq and re-warms it at `StartOfTurn`,
  while you are still speaking.
- Groq runs with `reasoning_effort: "low"` and `include_reasoning: false`, and its SSE
  stream is piped through untouched.
- Token fetch, mic permission and worklet load run in parallel on unmute; audio captured
  before the socket opens is queued, so first words are not lost.

## Configuration

| Variable | Default | |
|---|---|---|
| `DEEPGRAM_API_KEY` | — | Needs Member permissions or higher (required by `/v1/auth/grant`). |
| `GROQ_API_KEY` | — | |
| `PORT` | `3000` | |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | |
| `GROQ_REASONING_EFFORT` | `low` | `low`, `medium` or `high` |

Turn-detection settings (`eot_threshold`, `eager_eot_threshold`, `eot_timeout_ms`) are in
`public/app.js`. For non-English speech, switch the model there to `flux-general-multi`.

## Docs used

- Deepgram Flux: https://developers.deepgram.com/docs/flux/quickstart, https://developers.deepgram.com/docs/flux/state, https://developers.deepgram.com/reference/speech-to-text/listen-flux
- Deepgram tokens: https://developers.deepgram.com/guides/fundamentals/token-based-authentication
- Groq: https://console.groq.com/docs/model/openai/gpt-oss-120b, https://console.groq.com/docs/reasoning, https://console.groq.com/docs/api-reference
