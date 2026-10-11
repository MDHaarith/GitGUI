// The app's static markup; main.ts wires behaviour to these IDs.
export const markup = `
  <svg class="chrome-symbols" aria-hidden="true"><defs>
    <symbol id="chrome-branch" viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4-6 3-11 7"/></symbol>
    <symbol id="chrome-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
    <symbol id="chrome-fetch" viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></symbol>
    <symbol id="chrome-pull" viewBox="0 0 24 24"><path d="M12 3v13M7 11l5 5 5-5"/></symbol>
    <symbol id="chrome-push" viewBox="0 0 24 24"><path d="M12 21V8M7 13l5-5 5 5"/></symbol>
    <symbol id="chrome-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/></symbol>
    <symbol id="chrome-panel" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/></symbol>
    <symbol id="chrome-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></symbol>
    <symbol id="chrome-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></symbol>
    <symbol id="chrome-diamond" viewBox="0 0 24 24"><path d="m12 5 7 7-7 7-7-7z"/></symbol>
    <symbol id="chrome-close" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></symbol>
    <symbol id="chrome-down" viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></symbol>
  </defs></svg>
  <header class="toolbar" data-tauri-drag-region>
    <span class="brand" data-tauri-drag-region><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v10a4 4 0 0 0 4 4h1m5-14v2a5 5 0 0 1-5 5H7"/><circle cx="7" cy="5" r="2.5"/><circle cx="17" cy="5" r="2.5"/><circle cx="15" cy="19" r="2.5"/></svg>GitGUI<span class="app-version" id="app-version" hidden></span></span>
    <button class="secondary" id="open-repo">Open repository</button><button class="secondary" id="init-repo">Init repository</button><button class="secondary" id="clone-repo" title="Download a project from GitHub or another server">Clone</button>
    <select id="recent-repos" aria-label="Repository"><option value="">Recent repositories</option></select>
    <span class="toolbar-status" data-tauri-drag-region><span id="status" role="status" aria-live="polite">Ready</span><span id="operation-feedback" hidden><progress id="operation-progress" aria-label="Git operation progress" max="100"></progress><span id="operation-elapsed"></span></span></span>
    <div class="toolbar-actions"><button id="publish" data-repo hidden title="Back up this project online: a new private GitHub repository or one you already made">Publish</button><button aria-label="Fetch" id="fetch" data-repo data-tip="Fetch: download news from the server without changing your files"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-fetch"/></svg><span class="label">Fetch</span></button><button aria-label="Pull" id="pull" data-repo data-tip="Pull: download the server's new commits into your branch"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-pull"/></svg><span class="label">Pull</span><span class="count" id="behind-count" hidden></span></button><button aria-label="Push" id="push" data-repo data-tip="Push: upload your commits to the server (your backup)"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-push"/></svg><span class="label">Push</span><span class="count" id="ahead-count" hidden></span></button>
    <button aria-label="Refresh" id="refresh" data-repo><svg class="chrome-icon" id="refresh-icon" aria-hidden="true"><use href="#chrome-refresh"/></svg><span class="label">Refresh</span></button></div>
    <div class="window-controls" id="window-controls" hidden><button id="window-minimize" aria-label="Minimize window"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-chevron"/></svg></button><button id="window-maximize" aria-label="Maximize or restore window"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-diamond"/></svg></button><button id="window-close" aria-label="Close window"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-close"/></svg></button></div>
  </header>
  <nav class="scopebar" aria-label="History and repository actions">
    <label class="muted" for="scope">Scope</label><select id="scope" data-repo><option value="">All branches</option></select>
    <div class="history-search" role="search" aria-label="Search loaded history">
      <div class="search-field"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-search"/></svg><input id="history-search" type="search" aria-label="Search loaded commits by message, author, or hash" placeholder="Search loaded commits" autocomplete="off"></div>
      <span id="search-count" class="muted" aria-live="polite"></span><button id="search-all" class="chip" hidden title="Load up to 10,000 commits and search them all">Search all history</button>
      <button id="search-prev" aria-label="Previous matching commit" title="Previous match (Shift+Enter)"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-up"/></svg></button><button id="search-next" aria-label="Next matching commit" title="Next match (Enter)"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-down"/></svg></button>
    </div>
    <span class="spacer"></span>
    <button id="details-button" data-repo><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-panel"/></svg>Details</button>
    <button id="checkpoints-button" data-repo title="Save or restore snapshots of your files">Checkpoints</button>
    <span class="experiment-bar" id="experiment-bar" hidden>Experiment<button id="experiment-keep" data-repo title="Merge this experiment into the branch it started from">Keep it</button><button id="experiment-discard" data-repo title="Delete this experiment and return to where you were">Throw it away</button></span>
    <div class="menu"><button id="tools-button" aria-haspopup="menu" aria-expanded="false" aria-controls="tools-menu">Tools<svg class="chrome-icon" aria-hidden="true"><use href="#chrome-chevron"/></svg></button>
      <div class="menu-list" id="tools-menu" role="menu" hidden>
        <button role="menuitem" id="session-button" data-repo title="See what changed since your last checkpoint or commit, riskiest first, and undo single files">Review AI changes</button>
        <button role="menuitem" id="stash-button" data-repo title="Put unfinished changes aside, then bring them back later">Stashes</button>
        <button role="menuitem" id="rebase-button" data-repo title="Reorder, combine, edit, or remove unpublished commits">Clean up commits</button>
        <button role="menuitem" id="create-pr-button" data-repo hidden>Create pull request</button>
        <button role="menuitem" id="cleanup-button" data-repo title="Delete ignored build output and caches, and compact Git's own data">Free up space</button>
        <button role="menuitem" id="experiment-button" data-repo title="Work on a throwaway copy (a branch) that you can keep or discard">Try something risky</button>
        <button role="menuitem" id="run-button" data-repo title="Start your app and watch its output">Run project</button>
        <button role="menuitem" id="rules-button" data-repo title="Rules every AI agent reads before changing this project (AGENTS.md)">AI rules</button>
        <button role="menuitem" id="ai-settings-menu" title="Choose Claude, DeepSeek, OpenAI, Ollama, Codex, opencode, or any other AI">AI settings</button>
        <button role="menuitem" id="update-button" title="See whether a newer GitGUI is available">Check for updates</button>
        <button role="menuitem" id="help-button" title="How GitGUI works and what the Git words mean">Help</button>
      </div>
    </div>
    <button class="chip" id="changes-button" data-repo>Changes <span class="mono" id="changes-count">0</span></button>
  </nav>
  <div class="errorbar" id="error" role="alert" hidden><p id="error-text"></p><button id="dismiss-error" aria-label="Dismiss error">Close</button></div>
  <ul class="hintbar" id="git-hint" aria-label="Tips about this repository" hidden></ul>
  <main class="workspace" id="workspace">
    <aside class="branch-sidebar" id="branch-sidebar" aria-label="Branches and tags" hidden>
      <header class="panelbar"><h2>Repository</h2><span class="spacer"></span><button id="branch-actions" aria-label="Manage branches" data-repo>Manage</button></header>
      <nav class="ref-list" id="ref-list" aria-label="History scopes"></nav>
    </aside>
    <div class="repository-main">
    <div class="history-review">
    <section class="history" id="history" aria-label="Repository history">
      <div class="empty" id="welcome"><span class="eyebrow">A clear view of your code</span><h1>Your repository,<br>in view.</h1><p>Follow branches and merges. Review changes.<br>Make your next commit with confidence.</p><span class="row welcome-actions"><button class="primary" id="welcome-open">Open repository <span aria-hidden="true">↗</span></button><button class="secondary" id="welcome-clone">Clone from a URL</button></span><span class="welcome-note">Local repositories. Offline fonts. Your workflow.</span></div>
      <div class="empty" id="empty-history" hidden><h1>No commits yet</h1><p>Open Changes to stage files and create the first commit.</p></div>
      <div class="graph-scene" id="graph-scene" hidden>
        <table class="history-table" aria-label="Commit graph and history">
          <colgroup><col class="graph"><col><col class="author"><col class="date"><col class="sha"></colgroup>
          <thead><tr><th scope="col" aria-label="Graph"></th><th class="description" scope="col">Description</th><th scope="col">Author</th><th class="date-heading" scope="col">Date</th><th scope="col">Commit</th></tr></thead>
          <tbody id="history-rows"></tbody>
        </table>
        <svg class="graph-svg" id="graph" role="img" aria-label="Commit parent relationships"></svg>
      </div>
      <button class="load-more" id="load-more" hidden>Load more history</button>
    </section>
    <aside id="details" class="details-panel" aria-labelledby="detail-title" tabindex="-1" hidden>
      <div class="dialog-head"><h2 id="detail-title">Commit details</h2><button id="close-details">Close</button></div>
      <div class="metadata"><span id="detail-author"></span><span id="detail-date"></span><input id="detail-sha" readonly aria-label="Full commit object ID"><button id="copy-sha" class="chip" title="Copy the full commit ID">Copy</button></div>
      <pre class="message" id="detail-message"></pre><div class="parents" id="detail-parents"></div>
      <button type="button" class="chip" id="commit-explain">Explain this commit with AI</button>
      <div class="detail-controls"><label for="detail-parent">Compare to</label><select id="detail-parent"></select><label for="detail-file">Files</label><select id="detail-file"></select><button id="detail-file-history" type="button">History</button><button id="detail-file-prev" aria-label="Previous changed file" title="Previous file (Alt+Up)">↑</button><button id="detail-file-next" aria-label="Next changed file" title="Next file (Alt+Down)">↓</button><button type="button" class="diff-toggle" aria-pressed="false" title="Show old and new side by side">Side by side</button></div>
      <pre class="diff" id="detail-diff"></pre>
      <div class="row detail-actions"><button id="commit-revert" data-repo>Revert</button><button id="commit-cherry-pick" data-repo>Cherry-pick</button><button id="commit-tag" data-repo>Create tag</button><button id="commit-reset" data-repo>Reset branch here</button></div>
    </aside>
    </div>
    <section class="changes" id="changes" aria-label="Working changes" hidden>
      <header class="panelbar"><h2>Working changes</h2><span id="operation-note" class="muted"></span><button id="operation-continue" class="chip" hidden title="Finish the merge, rebase, cherry-pick or revert now that conflicts are resolved">Continue</button><button id="operation-abort" hidden title="Cancel it and go back to how things were before it started">Abort</button><span class="spacer"></span><button id="stash-changes" data-repo title="Put all changes aside (a stash) and bring them back later from Tools › Stashes">Stash</button><button id="undo-commit" data-repo title="Take back the last commit (if not pushed yet); its changes stay staged">Undo last commit</button><button id="close-changes">Close</button></header>
      <div class="changes-body">
        <div class="file-list" id="file-list"></div>
        <div class="working-preview"><div class="preview-head"><div class="preview-label" id="working-path">Select a file to review its diff.</div><button type="button" class="diff-toggle" aria-pressed="false" title="Show old and new side by side">Side by side</button></div><pre class="diff" id="working-diff"></pre></div>
        <form class="composer" id="commit-form">
          <div class="label-row"><label for="summary">Summary</label><span id="summary-hint" class="summary-hint"></span></div><input id="summary" required maxlength="1000" autocomplete="off" placeholder="Describe this commit" aria-describedby="summary-hint">
          <label for="body">Description <span class="muted">(optional)</span></label><textarea id="body" maxlength="64000" rows="3"></textarea>
          <div class="ai-row"><button type="button" class="chip" id="ai-message" data-repo title="Let the AI write the commit message from the staged changes">Write message with AI</button><button type="button" class="chip" id="ai-explain" data-repo title="Let the AI explain the staged changes in plain English">Explain staged changes</button><button type="button" class="chip" id="ai-settings" title="Choose Claude, DeepSeek, OpenAI, Ollama, Codex, opencode, or any other AI">AI settings</button></div>
          <div class="commit-row"><span id="version-controls"><label for="bump">Version <span class="mono" id="repo-version"></span></label> <select id="bump" data-repo><option value="minor">Minor · feature</option><option value="patch">Patch · fix</option><option value="major">Major · breaking</option><option value="">No bump</option></select></span><button id="enable-versioning" data-repo title="Block secrets and failing tests, and give every code commit its own version">Enable safeguards</button></div>
          <label class="amend-row"><input type="checkbox" id="amend"> Amend last commit <span class="muted">(change its message or add staged files)</span></label>
          <div class="commit-row"><span id="staged-count">0 staged files</span><button class="primary" id="commit-button" type="submit" data-repo>Commit staged</button></div>
        </form>
      </div>
    </section>
    </div>
  </main>
  <dialog class="branch-dialog" id="branches" aria-labelledby="branches-title">
    <div class="dialog-head"><h2 id="branches-title">Branches</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <div class="form-grid"><label for="branch-select">Switch to a local branch</label><select id="branch-select"></select><div class="row"><button class="chip" id="switch-branch">Switch branch</button></div>
      <label for="branch-rename">Rename the chosen branch</label><input id="branch-rename" maxlength="1024" autocomplete="off" placeholder="new-name">
      <div class="row"><button class="chip" id="rename-branch">Rename branch</button><button id="delete-branch" title="Delete the chosen branch (not the one you are on)">Delete branch</button></div>
      <label for="branch-name">Create branch</label><input id="branch-name" placeholder="feature/name" maxlength="1024" autocomplete="off">
      <label for="branch-start">Start at</label><select id="branch-start"><option value="head">Current HEAD</option><option value="selected">Selected commit</option></select>
      <div class="row"><button class="chip" id="create-branch">Create branch</button></div><p id="branch-note"></p>
    </div>
  </dialog>
  <dialog class="branch-dialog" id="checkpoint-dialog" aria-labelledby="checkpoint-title">
    <div class="dialog-head"><h2 id="checkpoint-title">Checkpoints</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <form id="checkpoint-form" class="form-grid"><label for="checkpoint-name">Save your current files</label><input id="checkpoint-name" maxlength="200" autocomplete="off" placeholder="Before asking the AI to …"><div class="row"><button class="chip" type="submit">Save checkpoint</button></div></form>
    <p class="muted">GitGUI also saves one automatically when you come back to the window (at most every 10 minutes). Restoring puts files back exactly as they were; your current files are saved as a checkpoint first, and files created later are kept.</p>
    <ol class="checkpoint-list" id="checkpoint-list"></ol>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="session-dialog" aria-labelledby="session-title">
    <div class="dialog-head"><h2 id="session-title">What did the AI change?</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <p id="session-note" class="muted"></p><ul class="health-list" id="health-list"></ul>
    <div class="row"><button class="chip" id="session-explain">Explain with AI</button><button id="session-undo-all">Undo all</button></div>
    <ol class="checkpoint-list" id="session-list"></ol><pre class="diff dialog-pre" id="session-diff"></pre>
  </dialog>
  <dialog class="branch-dialog" id="publish-dialog" aria-labelledby="publish-title">
    <div class="dialog-head"><h2 id="publish-title">Back up your code online</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <form id="publish-form" class="form-grid">
      <label for="publish-main">Main branch (GitHub shows this one first)</label><select id="publish-main"></select>
      <label class="choice"><input type="radio" name="publish-mode" value="github" checked> Create a new private GitHub repository (needs the GitHub CLI, signed in once with <code>gh auth login</code>)</label>
      <label class="choice"><input type="radio" name="publish-mode" value="url"> Use an empty repository I already made</label>
      <input id="publish-url" aria-label="Repository address" autocomplete="off" placeholder="https://github.com/you/project.git" disabled>
      <p class="muted">GitGUI uploads the main branch first, then the branch you are on.</p>
      <div class="row"><button class="primary" type="submit">Publish</button></div>
    </form>
  </dialog>
  <dialog class="branch-dialog" id="experiment-dialog" aria-labelledby="experiment-title">
    <div class="dialog-head"><h2 id="experiment-title">Try something risky</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <form id="experiment-form" class="form-grid"><p>GitGUI makes a separate copy of your code (a branch). Let the AI try anything there, then <strong>Keep it</strong> to bring the changes back or <strong>Throw it away</strong> to return exactly to where you were.</p><label for="experiment-name">What are you trying?</label><input id="experiment-name" maxlength="80" required autocomplete="off" placeholder="new login page"><div class="row"><button class="primary" type="submit">Start experiment</button></div></form>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="run-dialog" aria-labelledby="run-title">
    <div class="dialog-head"><h2 id="run-title">Run project</h2><span class="spacer"></span><button class="primary" id="run-start">Start</button><button id="run-stop" disabled>Stop</button><form method="dialog"><button type="submit">Close</button></form></div>
    <p class="muted">GitGUI guesses the start command (npm run dev, cargo run, python main.py…). Change it with <code>git config gitgui.runCommand "&lt;command&gt;"</code>.</p>
    <p class="run-hint" id="run-hint" role="alert" hidden></p><pre class="diff dialog-pre" id="run-output" aria-live="off"></pre>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="rules-dialog" aria-labelledby="rules-title">
    <div class="dialog-head"><h2 id="rules-title">AI rules (AGENTS.md)</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <form id="rules-form" class="form-grid"><p class="muted">Claude Code, Codex, Cursor and other agents read these rules before changing your project. GitGUI also links them from CLAUDE.md.</p><textarea id="rules-text" rows="16" maxlength="200000" aria-label="Rules for AI agents"></textarea><div class="row"><button type="button" id="rules-starter">Add starter rules</button><button class="primary" type="submit">Save rules</button></div></form>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="ai-dialog" aria-labelledby="ai-title">
    <div class="dialog-head"><h2 id="ai-title">AI</h2><span class="spacer"></span><button type="button" id="ai-settings-open">AI settings</button><form method="dialog"><button type="submit">Close</button></form></div>
    <form id="key-form" class="form-grid" hidden>
      <label for="ai-preset">AI provider</label><select id="ai-preset"></select>
      <label for="ai-base-url" data-ai="openai">API address</label><input id="ai-base-url" data-ai="openai" autocomplete="off" placeholder="https://api.example.com/v1">
      <label for="ai-model" data-ai="openai">Model</label><input id="ai-model" data-ai="openai" autocomplete="off" placeholder="model name">
      <label for="ai-command" data-ai="command">Command (reads the request on stdin, prints the answer)</label><input id="ai-command" data-ai="command" autocomplete="off" placeholder="codex exec -">
      <label for="api-key" data-ai="claude openai">API key</label><input id="api-key" data-ai="claude openai" type="password" autocomplete="off" placeholder="Leave empty to keep the saved key">
      <p class="muted" id="ai-provider-note"></p>
      <div class="row"><button class="primary" type="submit">Save AI settings</button></div>
    </form>
    <pre class="message ai-answer" id="ai-answer"></pre><p class="muted" id="ai-usage"></p>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="help-dialog" aria-labelledby="help-title">
    <div class="dialog-head"><h2 id="help-title">Welcome to GitGUI</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <h3 class="help-heading">How to work with an AI safely</h3>
    <ol class="tour">
      <li><strong>New project:</strong> Init repository creates one with safeguards: secrets and failing tests are blocked and every feature gets its own version.</li>
      <li><strong>Before asking an AI to change things:</strong> save a Checkpoint, or use Try something risky for big ideas.</li>
      <li><strong>After the AI is done:</strong> Review AI changes shows every changed file, riskiest first. Undo single files, or let the AI explain them. Pick Claude, DeepSeek, OpenAI, Ollama, Codex, opencode, or any other AI in AI settings.</li>
      <li><strong>Happy with it?</strong> In Changes, stage the files, press Write message with AI, choose a version, and Commit.</li>
      <li><strong>Back it up:</strong> Publish to GitHub once, then Push after each commit.</li>
      <li><strong>Something broke?</strong> Run shows your app's output and explains common crashes; Checkpoints and Undo last commit take you back.</li>
    </ol>
    <h3 class="help-heading">Git words</h3>
    <dl class="glossary">
      <dt>Commit</dt><dd>A saved version of your project with a message saying what changed.</dd>
      <dt>Stage</dt><dd>Choose which changed files go into the next commit.</dd>
      <dt>Branch</dt><dd>A separate line of work. Experiments are branches.</dd>
      <dt>Remote / GitHub</dt><dd>A copy of your project on a server: your backup and how you share code.</dd>
      <dt>Push / Pull / Fetch</dt><dd>Upload your commits / download others' commits / check for news without changing files.</dd>
      <dt>Merge conflict</dt><dd>Two changes edited the same lines; you pick which one to keep.</dd>
      <dt>Checkpoint</dt><dd>A GitGUI snapshot of all files that is not a commit; restore it any time.</dd>
      <dt>HEAD</dt><dd>The commit you are on right now.</dd>
      <dt>Stash</dt><dd>A shelf for unfinished changes: put them aside, switch tasks, bring them back later.</dd>
      <dt>Amend</dt><dd>Replace the last commit, to fix its message or add a forgotten file. Only before pushing.</dd>
      <dt>Rebase</dt><dd>Reorder or combine commits that have not been published yet.</dd>
    </dl>
    <h3 class="help-heading">Keyboard</h3>
    <dl class="glossary">
      <dt>Ctrl+O · Ctrl+R</dt><dd>Open a repository · refresh.</dd>
      <dt>Ctrl+F</dt><dd>Search history; Enter and Shift+Enter jump between matches.</dd>
      <dt>↑ ↓ · Space</dt><dd>In Changes: move between files · stage or unstage the file.</dd>
      <dt>Ctrl+Enter · Ctrl+Shift+P</dt><dd>Commit · push.</dd>
    </dl>
    <form method="dialog" class="dialog-foot"><button class="primary" type="submit">Got it</button></form>
  </dialog>
  <dialog class="branch-dialog" id="tag-dialog" aria-labelledby="tag-title">
    <div class="dialog-head"><h2 id="tag-title">Create tag</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <form id="tag-form" class="form-grid"><label for="tag-name">Tag name</label><input id="tag-name" maxlength="200" required autocomplete="off"><label for="tag-message">Message (optional)</label><input id="tag-message" maxlength="500" autocomplete="off" placeholder="Leave empty for a lightweight tag"><div class="row"><button class="primary" type="submit" data-repo>Create tag</button></div></form>
  </dialog>
  <dialog class="branch-dialog" id="reset-dialog" aria-labelledby="reset-title">
    <div class="dialog-head"><h2 id="reset-title">Reset current branch</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <form id="reset-form" class="form-grid"><label for="reset-mode">Keep changes as</label><select id="reset-mode"><option value="soft">Soft — keep changes staged</option><option value="mixed">Mixed — keep changes unstaged</option><option value="hard">Hard — discard changes (untracked files stay)</option></select><p class="muted">Hard reset saves a checkpoint before changing tracked files.</p><div class="row"><button class="primary" type="submit" data-repo>Reset branch</button></div></form>
  </dialog>
  <dialog class="branch-dialog" id="stash-dialog" aria-labelledby="stash-title">
    <div class="dialog-head"><h2 id="stash-title">Stashes</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <form id="stash-form" class="form-grid"><label for="stash-name">Put all current changes aside</label><input id="stash-name" maxlength="200" autocomplete="off" placeholder="What were you working on?"><div class="row"><button class="chip" type="submit" data-repo>Stash changes</button></div></form>
    <p class="muted">A stash is a shelf for unfinished work: your files go back to the last commit, and you can bring the changes back any time, on any branch.</p>
    <ol class="checkpoint-list" id="stash-list"></ol>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="file-history-dialog" aria-labelledby="file-history-title">
    <div class="dialog-head"><h2 id="file-history-title">File history</h2><button id="file-history-close">Close</button></div>
    <div id="file-history-list" class="history-list"></div><h3>Who changed each line</h3><div id="file-blame-list" class="blame-list"></div>
  </dialog>
  <dialog class="branch-dialog" id="ignore-dialog" aria-labelledby="ignore-title">
    <div class="dialog-head"><h2 id="ignore-title">Ignore this file?</h2><button id="ignore-close">Cancel</button></div>
    <p id="ignore-path"></p><div class="row"><button id="ignore-file">Ignore file</button><button id="ignore-folder">Ignore top folder</button></div>
  </dialog>
  <dialog class="branch-dialog" id="cleanup-dialog" aria-labelledby="cleanup-title">
    <div class="dialog-head"><h2 id="cleanup-title">Free up space</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <p class="muted">Files your .gitignore hides, largest first: build output, dependencies and caches can be deleted and are rebuilt when needed. Keep settings and secrets such as .env. Folders holding another repository are not shown.</p>
    <ol class="checkpoint-list" id="cleanup-list"></ol>
    <div class="row"><button class="chip" id="cleanup-delete" data-repo>Delete selected</button><span class="spacer"></span><button id="cleanup-compact" data-repo title="Pack Git's history data tighter (git gc). Nothing you can see changes.">Compact Git data</button></div>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="pull-request-dialog" aria-labelledby="pull-request-title">
    <div class="dialog-head"><h2 id="pull-request-title">Create pull request</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <form id="pull-request-form" class="form-grid">
      <label for="pr-title">Title</label><input id="pr-title" required maxlength="256" autocomplete="off">
      <label for="pr-body">Description</label><textarea id="pr-body" rows="10" maxlength="64000"></textarea>
      <label for="pr-base">Base branch</label><input id="pr-base" required autocomplete="off">
      <div class="row"><button type="button" id="pr-write-ai">Write with AI</button><span class="spacer"></span><button class="primary" type="submit">Create pull request</button></div>
    </form>
  </dialog>
  <dialog class="branch-dialog" id="clone-dialog" aria-labelledby="clone-title">
    <div class="dialog-head"><h2 id="clone-title">Clone a repository</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <form id="clone-form" class="form-grid">
      <label for="clone-url">Repository address</label><input id="clone-url" required autocomplete="off" placeholder="https://github.com/owner/project.git">
      <label for="clone-parent">Put it inside this folder</label><div class="row"><input id="clone-parent" readonly required placeholder="Choose a folder"><button type="button" class="chip" id="clone-browse">Choose…</button></div>
      <p class="muted" id="clone-note">GitGUI creates a new folder named after the project.</p>
      <div class="row"><button class="primary" type="submit">Clone</button></div>
    </form>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="rebase-dialog" aria-labelledby="rebase-title">
    <div class="dialog-head"><h2 id="rebase-title">Clean up commits</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <p class="muted">Choose what to do with each unpublished commit, then reorder them with the buttons.</p>
    <div id="rebase-commits" class="checkpoint-list"></div>
    <div class="dialog-foot"><button class="primary" id="rebase-apply" type="button">Apply</button></div>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="conflict-dialog" aria-labelledby="conflict-title">
    <div class="dialog-head"><h2 id="conflict-title">Resolve conflict</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <p class="muted">Each block below is a place where both sides changed the same lines. Pick what to keep for every block, then save.</p>
    <div id="conflict-blocks" class="conflict-blocks"></div>
    <div class="dialog-foot"><button class="primary" id="conflict-save" type="button">Save and mark fixed</button></div>
  </dialog>
  <dialog class="branch-dialog" id="remote-dialog" aria-labelledby="remote-title">
    <div class="dialog-head"><h2 id="remote-title">Choose remote</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <form id="remote-form" class="form-grid"><label for="remote-select">Remote</label><select id="remote-select"></select><p id="remote-url"></p><p id="remote-note"></p><button class="primary" id="remote-submit" type="submit">Continue</button></form>
  </dialog>
`;
