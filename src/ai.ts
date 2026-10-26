import type { AiProvider } from './git.ts';

export interface Preset { label: string; provider: AiProvider; note: string }
export const PRESETS: Record<string, Preset> = {
  claude: { label: 'Claude (Anthropic)', provider: { kind: 'claude', baseUrl: '', model: '', apiKey: '', command: '' }, note: 'Uses claude-opus-5-5. Key from console.anthropic.com, or ANTHROPIC_API_KEY.' },
  deepseek: { label: 'DeepSeek', provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '', command: '' }, note: 'Key from platform.deepseek.com.' },
  openai: { label: 'OpenAI', provider: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: '', command: '' }, note: 'Key from platform.openai.com.' },
  openrouter: { label: 'OpenRouter (many models)', provider: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini', apiKey: '', command: '' }, note: 'Key from openrouter.ai. Model names look like vendor/model.' },
  groq: { label: 'Groq', provider: { kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: '', command: '' }, note: 'Key from console.groq.com.' },
  ollama: { label: 'Ollama (local, free)', provider: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', apiKey: '', command: '' }, note: 'Runs on your computer; no key needed. Pull the model with ollama pull first.' },
  gemini: { label: 'Gemini', provider: { kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', apiKey: '', command: '' }, note: 'Key from aistudio.google.com.' },
  mistral: { label: 'Mistral', provider: { kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', apiKey: '', command: '' }, note: 'Key from console.mistral.ai.' },
  xai: { label: 'xAI', provider: { kind: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', apiKey: '', command: '' }, note: 'Key from console.x.ai. Choose a model available to your account.' },
  lmstudio: { label: 'LM Studio (local)', provider: { kind: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'local-model', apiKey: '', command: '' }, note: 'Start the local server and replace local-model with the loaded model ID.' },
  geminicli: { label: 'Gemini CLI', provider: { kind: 'command', baseUrl: '', model: '', apiKey: '', command: 'gemini -p "Respond to the request on stdin"' }, note: 'Uses your Gemini CLI login. Runs in an empty temporary folder; plain chat only.' },
  api: { label: 'Other OpenAI-compatible API', provider: { kind: 'openai', baseUrl: '', model: '', apiKey: '', command: '' }, note: 'Any service with an OpenAI-style /chat/completions endpoint (LM Studio, Together, Mistral, xAI…).' },
  codex: { label: 'Codex CLI', provider: { kind: 'command', baseUrl: '', model: '', apiKey: '', command: 'codex exec --skip-git-repo-check -' }, note: 'Uses your Codex login. Runs in a separate temporary folder; plain chat only.' },
  claudecode: { label: 'Claude Code CLI', provider: { kind: 'command', baseUrl: '', model: '', apiKey: '', command: 'claude -p' }, note: 'Uses your Claude Code login. Runs in an empty temporary folder.' },
  opencode: { label: 'opencode CLI', provider: { kind: 'command', baseUrl: '', model: '', apiKey: '', command: 'opencode run "$(cat)"' }, note: 'Uses your opencode setup. Runs in an empty temporary folder.' },
  command: { label: 'Other command-line agent', provider: { kind: 'command', baseUrl: '', model: '', apiKey: '', command: '' }, note: 'Any command that reads the request on stdin and prints the answer. Runs in an empty temporary folder, for up to 10 minutes.' },
};
export const STARTER_RULES = `# Rules for AI agents
- Make one small change at a time and explain what you changed in plain English.
- Never delete, skip, or weaken tests to make them pass; fix the code instead.
- Never write API keys, passwords, or tokens into code; read them from an ignored .env file.
- Ask before adding a dependency, and only use well-known, maintained packages.
- Keep files under about 500 lines; split large files into modules.
- Run the tests before saying you are done, and report any that fail.
- Never use git commit --no-verify, force-push, or rewrite history.
- Do not change files unrelated to the task.`;
