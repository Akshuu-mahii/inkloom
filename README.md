# SparkIQ

SparkIQ is an AI-powered brand intelligence workspace. It turns a rough product, service, food, community, or creator idea into a guided, checked brand strategy and a pamphlet-style kit.

## Setup

1. Install Node.js 20 or newer.
2. Get an API key from your chosen OpenAI-compatible provider (for OpenAI, create one at https://platform.openai.com/api-keys).
3. Open `backend/.env` and replace `your_openai_compatible_api_key_here` with the key. The file is ignored by git. `backend/.env.example` shows every supported setting.
4. From the repository root, install all workspaces:

```bash
npm install
```

5. Start both applications:

```bash
npm run dev
```

The UI is at http://localhost:5173 and the API is at http://localhost:4000. You can also run `npm run dev --workspace backend` and `npm run dev --workspace frontend` in separate terminals.

The backend loads the key with dotenv and is the only process that calls the LLM. It exits at startup if `LLM_API_KEY` is missing. If the provider is temporarily unavailable, the app returns a deterministic, idea-aware local result so the interaction remains usable and retryable.

## Example ideas

- `I want to start a home bakery that sells birthday cakes.`
- `A cyber security tool for small teams.`
- `A YouTube channel teaching easy regional cooking.`

## Feature map

The ten stages are separate backend calls. Every call receives the merged JSON context from previous stages. The UI exposes approve/edit/regenerate controls, guided suggestions, Why this reasoning, cliche detection, competitor verification labels, debate agents, score reasons and auto-fix fields, a founder chat, language adaptation controls, launch/e-commerce copy, PDF/share actions, customer feedback demo, voice-over action, and an HTML poster download.

## Scripts

- `npm run build`: production-build the frontend.
- `npm run dev`: run frontend and backend together.
- `npm run start --workspace backend`: run the backend without watch mode.