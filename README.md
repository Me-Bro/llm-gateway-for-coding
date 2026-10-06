# llm-gateway

OpenAI-compatible endpoint that sends each request to an available free provider (Z.ai, Gemini, OpenRouter, NVIDIA, Groq) and moves to the next one on rate limits, outages or bad keys. Standalone copy of `freeflow-n8n/llm-gateway`, without Docker.

## Run

1. Create your `.env` and fill it in: `GATEWAY_API_KEY` (a secret you invent) plus at least one provider key (see [Get API keys](#get-api-keys)):

   ```sh
   cp .env.example .env
   ```

2. Start it (Node 22+, no dependencies):

   ```sh
   npm start
   ```

   It listens on `127.0.0.1:18181`. Restart it after changing `providers.json` or `.env`. Tests: `npm test`.

3. Call it like OpenAI:

   ```sh
   curl http://127.0.0.1:18181/v1/chat/completions \
     -H "Authorization: Bearer $GATEWAY_API_KEY" -H "Content-Type: application/json" \
     -d '{"model":"smart","messages":[{"role":"user","content":"Say hi"}]}'
   ```

   The `x-llm-provider` and `x-llm-model` response headers show who answered.

## Get API keys

There are two kinds of key in `.env`:

- **`GATEWAY_API_KEY`** is not from any service. It is a password you make up, and the tools that call the gateway send it. Generate one:

  ```sh
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

- **Provider keys** come from each free service below. The gateway skips any provider whose key is empty, and more keys mean more free capacity to fail over to. Start with Z.ai and Gemini; the rest are optional.

| Provider | `.env` variable | Key page | Key looks like |
|---|---|---|---|
| Z.ai (GLM flash models) | `ZAI_API_KEY` | <https://z.ai/manage-apikey/apikey-list> | two parts joined by a dot |
| Google Gemini | `GEMINI_API_KEY` | <https://aistudio.google.com/apikey> | `AQ.…` |
| OpenRouter (free models) | `OPENROUTER_API_KEY` | <https://openrouter.ai/settings/keys> | `sk-or-…` |
| NVIDIA NIM | `NVIDIA_API_KEY` | <https://build.nvidia.com/settings/api-keys> | `nvapi-…` |
| Groq | `GROQ_API_KEY` | <https://console.groq.com/keys> | `gsk_…` |

Paste each key into `.env` with no quotes or spaces around it, e.g. `GEMINI_API_KEY=AQ.xxxxxxxx`. Keep `.env` private: it is in `.gitignore`.

### Z.ai

1. Go to the [Z.ai Open Platform](https://z.ai) and register or log in.
2. Open the [API Keys page](https://z.ai/manage-apikey/apikey-list), create a key, and copy it.

`glm-4.7-flash` and `glm-4.5-flash` (the models in `smart`) are free. Newer GLM models need account balance: `glm-5.3-flash` answered `Insufficient balance or no resource package`.

### Google Gemini

1. Sign in at [Google AI Studio](https://aistudio.google.com/apikey) with a Google account and accept the Terms of Service. New users get a default Google Cloud project and an API key automatically.
2. If you already use Google Cloud, AI Studio does not create a project for you: import one in the Projects view, then create a key from the API keys page.
3. Copy the key.

Keys created in AI Studio since 28 May 2026 are "auth keys" (they start with `AQ.`); those work with the gateway. Free quotas are per model, which is why `providers.json` lists several Gemini models as separate entries. See Google's [API key guide](https://ai.google.dev/gemini-api/docs/api-key) for key types and restrictions.

### OpenRouter

1. Sign up at [openrouter.ai](https://openrouter.ai) and open [Settings → Keys](https://openrouter.ai/settings/keys).
2. Create a key, give it a name, and optionally set a credit limit.
3. Copy it now.

The gateway only uses models whose id ends in `:free`. They have a daily request cap per account, and `GET https://openrouter.ai/api/v1/key` (with your key as a Bearer token) shows how many you have left. Free models are often rate-limited upstream and answer 429; the gateway then moves on.

### NVIDIA NIM

1. Go to [build.nvidia.com](https://build.nvidia.com), open any model's page, and click **Get API Key**.
2. Enter your email and complete sign-up. This makes you a member of the free NVIDIA Developer Program.
3. Copy the key from the pop-up (later, manage keys at [Settings → API Keys](https://build.nvidia.com/settings/api-keys)).

NVIDIA offers this access for prototyping and testing, not production. In testing, `moonshotai/kimi-k3` and `deepseek-ai/deepseek-v4.1-flash` did not answer within 120 seconds, so NVIDIA is the last entry in `smart`.

### Groq

1. Sign up at [console.groq.com](https://console.groq.com) and open [API Keys](https://console.groq.com/keys).
2. Create an API key and copy it.

The free tier allows only 8K tokens per minute on every chat model, which is below what coding agents send, so Groq serves only `fast`, `json` and `vision` here.

### Check that a key works

Start the gateway and read the `llm-gateway listening` line: `providers` lists the entries whose keys were found, `skipped` those without. Then ask each provider by a real model name, which routes only to the providers that list it:

```sh
curl http://127.0.0.1:18181/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"glm-4.5-flash","messages":[{"role":"user","content":"Say hi"}]}'
```

| Provider | `model` to request |
|---|---|
| Z.ai | `glm-4.5-flash` |
| Gemini | `gemini-3.6-flash` |
| OpenRouter | `cohere/north-mini-code:free` |
| NVIDIA | `moonshotai/kimi-k3` (may be very slow) |
| Groq | `openai/gpt-oss-120b` |

The `x-llm-provider` response header shows who answered. A `401` in the log (`llm provider failed`) means that provider's key is wrong; the gateway then disables it until restart.

## Use it from a coding tool

Every tool needs the same three things: base URL `http://127.0.0.1:18181/v1` (the `/v1` is required), your `GATEWAY_API_KEY`, and model `smart`. The gateway does **not support streaming yet** and answers `stream: true` with a 400, so the tool must be set to non-streaming. There is no `/v1/models` endpoint either, so a model dropdown stays empty: type `smart`.

| Tool | Works? | Notes |
|---|---|---|
| [Continue](#continue-recommended) | yes | Recommended. Streaming can be turned off. |
| [Roo Code](#roo-code-works-with-caveats) | yes, with caveats | Streaming can be turned off, but it has the heaviest requests. |
| Aider | yes | `aider --openai-api-base http://127.0.0.1:18181/v1 --openai-api-key <GATEWAY_API_KEY> --model openai/smart --no-stream` |
| Cline and most other agents | not yet | They always stream. Needs streaming support in the gateway. |

### Continue (recommended)

Continue's chat and edit requests carry your message and the context you attach, while Roo Code sends a 10K+ token prompt on every request. That is much easier on free-tier token limits. Verified against Continue's source (v2.0.0); not yet run end to end through this gateway.

1. Open `~/.continue/config.yaml` (`C:\Users\<you>\.continue\config.yaml` on Windows; or the gear icon in the Continue panel, then "Open config") and add the model:

   ```yaml
   name: Main Config
   version: 1.0.0
   schema: v1
   models:
     - name: Free Gateway (smart)
       provider: openai
       model: smart
       apiBase: http://127.0.0.1:18181/v1
       apiKey: <GATEWAY_API_KEY>
       roles:
         - chat
         - edit
         - apply
       capabilities:
         - tool_use
       defaultCompletionOptions:
         stream: false
         contextLength: 128000
         maxTokens: 16384
   ```

2. Save (Continue reloads the config) and pick **Free Gateway (smart)** in the model dropdown.

| Setting | Why |
|---|---|
| `stream: false` | Required. Continue streams by default and the gateway rejects that. It is accepted by Continue's config schema even though its docs do not list it. It must sit under `defaultCompletionOptions`. |
| `capabilities: tool_use` | Continue guesses tool support from the model name and `smart` is unknown, so Agent mode stays off without it. Drop it for plain chat. |
| no `autocomplete` role | Tab completion fires on nearly every pause in typing and would use up the free quotas within minutes. |
| `contextLength: 128000` | The smallest context window in the `smart` chain. |

Replies appear all at once, not word by word. In Agent mode the Z.ai model sometimes answers in plain text instead of calling a tool.

### Roo Code (works, with caveats)

Roo Code works through the gateway (tested), but read the caveats below first.

Settings, under the gear icon, Providers:

| Option | Value |
|---|---|
| API Provider | `OpenAI Compatible` |
| Base URL | `http://127.0.0.1:18181/v1` |
| API Key | your `GATEWAY_API_KEY` |
| Model | `smart` (typed in; the dropdown is empty) |
| Enable streaming | **off** (required) |
| Use Azure / Enable R1 model parameters / Include max output tokens | off |
| Context Window Size / Max Output Tokens | `128000` / `16384` |
| Image Support / Computer Use / Prompt Caching | off |
| Input / Output / Cache prices | `0` |
| Rate limit (optional) | `3` to `5` seconds, to space out requests on free tiers |

Caveats:

- **Hangs on "API Request..." with VS Code 1.140+ (Roo Code 3.54.0).** Roo cannot find VS Code's bundled ripgrep, fails before sending anything, and the gateway log stays empty. The extension host log (`%APPDATA%\Code\logs\<session>\window<N>\exthost\exthost.log`) shows `Error: Could not find ripgrep binary`. Workaround on Windows (user install); repeat it after every VS Code update, because each update installs into a new folder:

  ```powershell
  $app = Get-ChildItem "$env:LOCALAPPDATA\Programs\Microsoft VS Code" -Directory |
    Where-Object { Test-Path "$($_.FullName)\resources\app\node_modules.asar.unpacked" } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $bin = "$($app.FullName)\resources\app\node_modules.asar.unpacked\@vscode"
  New-Item -ItemType Directory -Force "$bin\ripgrep\bin" | Out-Null
  Copy-Item "$bin\ripgrep-universal\bin\win32-x64\rg.exe" "$bin\ripgrep\bin\rg.exe"
  ```

  Then reload the window ("Developer: Reload Window") and start a new task.
- **The Model field must be a name the gateway knows** (`smart`, `fast`, `json`, `vision`, or a model from `providers.json`). Roo does not complain about a wrong one; the gateway answers 400 `No configured provider offers model "..."`.
- **Every request is large.** Roo's system prompt plus tool definitions is 10K+ tokens and grows over a task. That is why Groq (8K tokens/min on its free tier) is left out of `smart`, and why long tasks use up Gemini's small daily quotas and move on down the list.
- **Slow replies.** The free Z.ai models can take 10 to 50 seconds per reply, and a `429` from `glm-4.7-flash` costs a second before failing over.
- **Plain-text answers.** Models sometimes answer in text when a tool call is expected. Roo reminds the model and retries, which costs one extra request.
- **Nothing in the log?** See [Logging](#logging): the last line a request reaches tells you where it stopped (rejected with 401, 404 or 400, still waiting on a provider, or never arrived).

## Models

`model` is either an alias (`fast`, `smart`, `json`, `vision`) or a real model name. Each provider maps the aliases in `providers.json`. A provider without a mapping for an alias is skipped for it, and a real model name goes only to providers that list it. The model names in `providers.json` are starting points: check them against each provider's model list once you have keys.

Free quotas are per model, so one key can back several entries: give each entry its own `name` and model (as with the `zai-*`, `gemini-*` and `openrouter-*` entries). Providers are tried in the order they appear. `smart` (the alias for coding agents) tries Z.ai GLM, then Gemini Flash models, then OpenRouter free models, then NVIDIA. Groq is left out of it because its free tier allows 8K tokens/min.

## Failover rules

| Provider response | Effect |
|---|---|
| 429 | cool down for `Retry-After`, otherwise 60s, doubling to 15 min |
| 5xx / timeout / network error | cool down 30s |
| 401 | provider disabled until restart (bad key) |
| 403 | that provider+model disabled until restart (some providers use 403 for model-specific restrictions) |
| 400 / 413 / 422, or bad JSON when `response_format` asks for JSON | try the next provider, no cooldown |

Cooling providers are still tried, just last. If every provider fails, the gateway returns 503 with each attempt, or 400 if every provider rejected the request itself.

## Logging

Every request gets an 8-character id, shown on each of its log lines and returned in the `x-request-id` header. A request logs, in order: `request received`, `body parsed` (model, stream, message and tool counts, size), `routing` (provider order, cooling and disabled ones), then `llm attempt` and `llm ok` / `llm provider failed` for each provider tried, and finally `response sent`. Requests the gateway refuses itself (bad key, unknown path, streaming) log `request rejected` with the reason, and `client disconnected before response` means the caller gave up first. Prompt content and keys are never logged.

| Last line you see for a request | Meaning |
|---|---|
| nothing at all | the tool is not reaching this gateway (check base URL, key and which profile is selected) |
| `request rejected` 401 / 404 / 400 | wrong key / base URL missing `/v1` / streaming still on or unknown model |
| `llm attempt` with no result yet | a provider is still working (up to its `timeoutMs`) |
| `client disconnected before response` | the tool gave up or you cancelled first |
| `response sent` 200 | the gateway did its part |

## Environment

Copy `.env.example` to `.env`.

| Variable | Default | |
|---|---|---|
| `GATEWAY_API_KEY` | required | key callers send as `Authorization: Bearer …` |
| `ZAI_API_KEY`, `NVIDIA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | | providers without a key are skipped |
| `HOST` / `PORT` | `127.0.0.1` / `18181` | |
| `PROVIDERS_FILE` | `./providers.json` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FILE` | | also append every log line to this file (`logs/gateway.log` in `.env.example`) |
