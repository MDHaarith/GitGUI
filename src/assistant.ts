import { api, type AiPermission, type ChatMessage, type ChatReply, type RepoInfo, type ToolCall, type Preview } from './git.ts';
import { wireDropdown } from './dropdown.ts';
import { toolAllowed, writeTool } from './assistant-policy.ts';
import './assistant.css';

export function mountAssistant(current: () => RepoInfo | null, refresh: () => Promise<void>, usage: (reply: ChatReply) => void, settings: () => void, renderPreview: (target: HTMLElement, preview: Preview) => void) {
  const panel = document.createElement('aside');
  panel.id = 'assistant-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Repository assistant');
  panel.innerHTML = `<header class="row"><strong>Assistant</strong><span class="spacer"></span><button type="button" data-settings>Settings</button><button type="button" data-close aria-label="Close assistant">Close</button></header>
    <label>Permission <select id="assistant-permission" aria-label="Assistant permission"><option value="read-only">Read-only</option><option value="commits">Commits</option><option value="everything">Everything</option></select></label>
    <p class="muted">Repository content is sent to your selected provider. Every write needs Allow and saves a checkpoint. Command-line agents support plain chat only.</p>
    <div class="assistant-chat" role="log" aria-label="Assistant conversation" aria-live="polite"></div>
    <form><label class="assistant-context" for="assistant-prompt"></label><textarea id="assistant-prompt" rows="3" placeholder="Ask about this repository…" aria-label="Message to assistant"></textarea><div class="row"><button type="button" data-new>New chat</button><span class="spacer"></span><button type="submit">Send</button></div></form>`;
  document.getElementById('app')!.append(panel);
  const select = panel.querySelector('select')!;
  wireDropdown(select);
  const form = panel.querySelector('form')!, prompt = panel.querySelector('textarea')!, log = panel.querySelector('.assistant-chat')!, send = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  const toggle = document.getElementById('assistant-button')!;
  let repoId: number | null = null, history: ChatMessage[] = [], generation = 0, running = false;
  let declinePending: (() => void) | null = null;
  const permission = () => select.value as AiPermission;
  function append(role: string, text: string) {
    const item = document.createElement('article');
    const label = document.createElement('strong'); label.textContent = role;
    const body = document.createElement('pre'); body.textContent = text;
    item.append(label, body); log.append(item); item.scrollIntoView({ block: 'nearest' });
    return item;
  }
  function reset() {
    generation++; declinePending?.(); declinePending = null; history = []; running = false;
    send.disabled = false; prompt.disabled = false; log.replaceChildren();
  }
  function sync() {
    const repo = current();
    if (repoId !== (repo?.id ?? null)) { reset(); repoId = repo?.id ?? null; prompt.value = ''; }
    panel.querySelector('.assistant-context')!.textContent = repo ? `${repo.root} · ${repo.branch ?? 'detached HEAD'}` : 'Open a repository to chat';
    send.disabled = running || !repo;
    if (!repo && !panel.hidden) close();
  }
  function close() { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); declinePending?.(); toggle.focus(); }
  toggle.onclick = () => { if (!panel.hidden) close(); else { sync(); panel.hidden = false; toggle.setAttribute('aria-expanded', 'true'); prompt.focus(); } };
  panel.querySelector<HTMLButtonElement>('[data-close]')!.onclick = close;
  panel.querySelector<HTMLButtonElement>('[data-settings]')!.onclick = settings;
  panel.querySelector<HTMLButtonElement>('[data-new]')!.onclick = reset;
  select.onchange = () => { declinePending?.(); };
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  function approve(item: HTMLElement, call: ToolCall, run: number): Promise<boolean> {
    return new Promise(resolve => {
      const actions = document.createElement('div'); actions.className = 'row';
      const allow = document.createElement('button'), deny = document.createElement('button');
      allow.type = deny.type = 'button'; allow.textContent = 'Allow'; deny.textContent = 'Deny';
      const finish = (allowed: boolean) => { actions.remove(); declinePending = null; resolve(allowed); };
      allow.onclick = () => finish(run === generation && toolAllowed(call.name, permission()));
      deny.onclick = () => finish(false); declinePending = () => finish(false);
      actions.append(allow, deny); item.append(actions);
      // Closing the panel or switching repositories must never leave an invisible approval pending.
      if (panel.hidden || run !== generation) finish(false);
    });
  }
  async function execute(call: ToolCall, id: number, run: number) {
    const item = append(`Tool · ${call.name}`, JSON.stringify(call.input, null, 2));
    let result: string;
    try {
      if (!toolAllowed(call.name, permission())) throw new Error('Disabled by the selected permission level.');
      const write = writeTool(call.name);
      const snapshot = write ? await api.status(id) : null;
      if (run !== generation) return;
      if (write && !await approve(item, call, run)) throw new Error('Denied by user.');
      if (run !== generation || current()?.id !== id) return;
      result = await api.assistantTool(id, call, permission(), write, snapshot?.token ?? '');
      if (write) await refresh();
    } catch (error) { result = `Error: ${String(error)}`; }
    if (run !== generation) return;
    const output = document.createElement('pre'); output.textContent = result; item.append(output);
    if (call.name === 'diff' || call.name === 'show_file') {
      try {
        const preview = JSON.parse(result);
        if (typeof preview.text === 'string' && typeof preview.binary === 'boolean') { output.className = 'diff'; renderPreview(output, preview); }
      } catch { /* Errors remain visible as plain text. */ }
    }
    history.push({ role: 'tool', text: result, calls: [], toolId: call.id });
  }
  form.onsubmit = async event => {
    event.preventDefault(); sync();
    const repo = current(), text = prompt.value.trim();
    if (!repo || !text || running) return;
    const run = generation, id = repo.id;
    running = true; send.disabled = true; prompt.disabled = true; prompt.value = '';
    history.push({ role: 'user', text, calls: [], toolId: null }); append('You', text);
    try {
      for (let round = 0; round < 12; round++) {
        const reply = await api.assistantChat(id, history, permission());
        if (run !== generation || current()?.id !== id) return;
        usage(reply); history.push(reply.message);
        if (reply.message.text) {
          const item = append('Assistant', reply.message.text);
          const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy Markdown';
          copy.onclick = async () => { try { await navigator.clipboard.writeText(reply.message.text); copy.textContent = 'Copied'; } catch { append('Error', 'Could not copy. Select the answer and copy it manually.'); } };
          item.append(copy);
        }
        if (!reply.message.calls.length) return;
        for (const call of reply.message.calls) { await execute(call, id, run); if (run !== generation) return; }
        if (round === 11) append('Assistant', 'Tool limit reached. Send another message to continue.');
      }
    } catch (error) { if (run === generation) append('Error', String(error)); }
    finally { if (run === generation) { running = false; prompt.disabled = false; sync(); prompt.focus(); } }
  };
  prompt.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
  return { sync };
}
