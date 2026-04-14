# tts-stream-player

A minimal browser library for streaming TTS audio playback via the Web Audio API.
Bridges the gap between TTS API responses (HTTP using chunked transfer encoding) and the browser speaker.

```
Without tts-stream-player:  wait = total generation time
With    tts-stream-player:  wait = TTFB (~100–500ms)
```

## Format support
-  PCM 16-bit
-  MP3
-  WAV (RIFF/PCM 16-bit)

## Who is this for
- **Separate LLM and TTS** — you own the full pipeline (your LLM, your RAG, your prompt logic) and just want HTTP streaming playback in the browser
- **Custom or self-hosted TTS** — your TTS engine doesn't support WebRTC
- **Cost-conscious teams** — ElevenLabs TTS API is cheaper per minute than Conversational AI; this library gives you streaming playback without paying for WebRTC infrastructure

## Use cases
- Adding voice responses to an existing web chat or chatbot
- Campaign pages and interactive demos
- Accessibility — reading page content or LLM responses aloud
- Internal tools where a full voice-agent stack is overkill

## Features

- PCM 16-bit, MP3, and WAV streaming playback via Web Audio API
- Seamless chunk scheduling (no gaps between chunks)
- Time-based buffer queue for absorbing network jitter
- Underflow recovery — automatically rebuffers and resumes after network stalls
- Safari autoplay unlock helper
- Per-session `start` / `end` / `buffering` event hooks
- Session cancellation and global interrupt

![processing flow](./assets/tool_flow.png)

## Installation

```bash
npm install tts-stream-player
```

## Usage

```typescript
import { TTSStreamPlayer } from 'tts-stream-player'

const player = new TTSStreamPlayer({
  sampleRate: 16000,
  channels: 1,
  minBufferMs: 150, // start playback after 150ms of audio is buffered
})

// Call inside a user gesture (click, tap)
startButton.addEventListener('click', async () => {
  await player.unlock()

  const response = await fetch('/api/tts', {
    method: 'POST',
    body: JSON.stringify({ text: 'Hello, world.' }),
  })

  const session = await player.play(response.body)

  session.on('start',     () => console.log('playing'))
  session.on('buffering', () => console.log('rebuffering...'))
  session.on('playing',   () => console.log('resumed'))
  session.on('end',       () => console.log('done'))
})

// Interrupt immediately (e.g. user starts speaking)
micButton.addEventListener('click', () => {
  player.interrupt()
})
```

## API

### `new TTSStreamPlayer(options)`


| Option        | Type                  | Required | Description                                                                                                       |
| ------------- | --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `sampleRate`  | `number`              | yes      | Sample rate for the `AudioContext`. For PCM, must match the stream. For MP3, the browser resamples automatically. |
| `channels`    | `number`                       | no       | Number of channels. Default: `1`. Ignored for MP3 and WAV (taken from the stream).                                |
| `minBufferMs` | `number`                       | no       | Milliseconds of audio to buffer before playback starts (and before resuming after underflow). Default: `100`      |
| `format`      | `'pcm_16bit' \| 'mp3' \| 'wav'` | no       | Audio format of the stream. Default: `'pcm_16bit'`                                                                |


### `player.unlock(): Promise<void>`

Initializes and resumes the `AudioContext`. Must be called inside a user gesture event handler (click, tap). Required for Safari and other browsers that block autoplay.

### `player.play(stream): Promise<Session>`

Starts streaming playback from a `ReadableStream<Uint8Array>`. Returns a `Session` object.

### `player.interrupt(): void`

Suspends audio output. The `AudioContext` remains alive and can be resumed.

### `session.on(event, handler): this`


| Event       | When                                             |
| ----------- | ------------------------------------------------ |
| `start`     | First chunk has been scheduled for playback      |
| `buffering` | Buffer exhausted mid-stream; waiting to rebuffer |
| `playing`   | Rebuffering complete; playback has resumed       |
| `end`       | Stream has ended or session was cancelled        |


### `session.cancel(): void`

Cancels this session and suspends the `AudioContext`.

## Formats

### PCM (default)

Supports **16-bit signed PCM** (little-endian), the default output format of ElevenLabs (`pcm_16000`, `pcm_22050`, `pcm_24000`) and OpenAI TTS (`pcm`).

Make sure the `sampleRate` option matches the format requested from the API.

```typescript
// ElevenLabs example — request PCM at 16kHz
const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/{id}/stream?output_format=pcm_16000', {
  method: 'POST',
  headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Hello.', model_id: 'eleven_flash_v2_5' }),
})

const player = new TTSStreamPlayer({ sampleRate: 16000 })
await player.unlock()
await player.play(response.body)
```

### MP3

Supports **MPEG1/2/2.5 Layer III** streaming. Incoming bytes are parsed frame-by-frame using the MP3 frame header, and each batch of complete frames is decoded via `AudioContext.decodeAudioData()`.

```typescript
// OpenAI TTS example — MP3 output
const response = await fetch('https://api.openai.com/v1/audio/speech', {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'tts-1', voice: 'alloy', input: 'Hello.', response_format: 'mp3' }),
})

const player = new TTSStreamPlayer({ sampleRate: 44100, format: 'mp3' })
await player.unlock()
await player.play(response.body)
```

> **Note:** Because `decodeAudioData` is called per frame batch, there may be a brief encoder-delay gap (~13 ms) at each batch boundary. For seamless MP3 streaming a WASM decoder (e.g. minimp3) is needed; this implementation keeps zero dependencies.

### WAV

Supports **RIFF/WAV PCM 16-bit** streams. The WAV header is parsed automatically to extract the sample rate and channel count — you do not need to set `channels` or match `sampleRate` to the stream.

Three streaming patterns are handled transparently:

- **Full WAV file** — a single RIFF header at the start, followed by raw PCM bytes.
- **Per-chunk headers** — each chunk carries its own RIFF header (e.g. when a proxy re-wraps every PCM chunk). Headers are stripped per chunk.
- **Headerless PCM** — if no RIFF magic is found in the first 44 bytes the data is treated as raw PCM 16-bit, using the constructor's `sampleRate` and `channels`.

Multi-channel audio is supported; interleaved samples are deinterleaved automatically.

```typescript
// ElevenLabs example — pipe PCM through a WAV header transform
const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/{id}/stream?output_format=pcm_16000', {
  method: 'POST',
  headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Hello.', model_id: 'eleven_flash_v2_5' }),
})

// Prepend a RIFF header so the stream is treated as WAV
const wavStream = response.body.pipeThrough(prependWavHeader(16000))

const player = new TTSStreamPlayer({ sampleRate: 16000, format: 'wav' })
await player.unlock()
await player.play(wavStream)
```

## Browser support

Requires Web Audio API support.


| Browser | Support               |
| ------- | --------------------- |
| Chrome  | ✅                     |
| Firefox | ✅                     |
| Edge    | ✅                     |
| Safari  | ✅ (unlock() required) |

## License

MIT
