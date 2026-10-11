pub mod assist;
pub mod git;
pub mod runner;
pub mod version;
use git::{
    Backend, Checkpoint, CommitDetails, GraphPage, Junk, Preview, Progress, RepoInfo, Session,
    Stash,
};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, State};

#[derive(Default)]
pub struct AppState(Arc<Mutex<Backend>>);

async fn task<T: Send + 'static>(
    state: State<'_, AppState>,
    write: bool,
    action: impl FnOnce(&mut Backend) -> git::Result<T> + Send + 'static,
) -> git::Result<T> {
    let shared = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut backend = if write {
            shared.try_lock().map_err(|_| {
                "Another Git operation is running. Wait for it to finish.".to_owned()
            })?
        } else {
            shared.lock().map_err(|_| {
                "Repository state is unavailable; restart the application.".to_owned()
            })?
        };
        action(&mut backend)
    })
    .await
    .map_err(|e| format!("Git task failed: {e}"))?
}

#[tauri::command]
fn startup_path() -> Option<String> {
    std::env::args_os().skip(1).find_map(|arg| {
        let path = std::path::Path::new(&arg);
        if path.is_dir() {
            path.to_str().map(str::to_owned)
        } else {
            None
        }
    })
}
#[tauri::command]
async fn open_repository(path: String, state: State<'_, AppState>) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.open(&path)).await
}
#[tauri::command]
async fn init_repository(path: String, state: State<'_, AppState>) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.init(&path)).await
}
#[tauri::command]
async fn enable_versioning(repo_id: u64, state: State<'_, AppState>) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.enable_versioning(repo_id)).await
}
#[tauri::command]
async fn list_checkpoints(
    repo_id: u64,
    state: State<'_, AppState>,
) -> git::Result<Vec<Checkpoint>> {
    task(state, false, move |b| b.checkpoints(repo_id)).await
}
#[tauri::command]
async fn save_checkpoint(
    repo_id: u64,
    label: String,
    state: State<'_, AppState>,
) -> git::Result<Vec<Checkpoint>> {
    task(state, true, move |b| b.checkpoint(repo_id, &label)).await
}
#[tauri::command]
async fn restore_checkpoint(
    repo_id: u64,
    oid: String,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.restore_checkpoint(repo_id, &oid, &token)
    })
    .await
}
#[tauri::command]
async fn get_status(repo_id: u64, state: State<'_, AppState>) -> git::Result<RepoInfo> {
    task(state, false, move |b| b.status(repo_id)).await
}
#[tauri::command]
async fn get_graph(
    repo_id: u64,
    scope: Option<String>,
    limit: u32,
    graph_id: Option<u64>,
    state: State<'_, AppState>,
) -> git::Result<GraphPage> {
    task(state, false, move |b| {
        b.graph(repo_id, scope, limit, graph_id)
    })
    .await
}
#[tauri::command]
async fn get_commit(
    repo_id: u64,
    oid: String,
    parent: Option<String>,
    state: State<'_, AppState>,
) -> git::Result<CommitDetails> {
    task(state, false, move |b| {
        b.commit_details(repo_id, &oid, parent)
    })
    .await
}
#[tauri::command]
async fn get_commit_diff(
    repo_id: u64,
    oid: String,
    parent: Option<String>,
    file_id: Option<String>,
    state: State<'_, AppState>,
) -> git::Result<Preview> {
    task(state, false, move |b| {
        b.commit_diff(repo_id, &oid, parent, file_id)
    })
    .await
}
#[tauri::command]
async fn get_working_diff(
    repo_id: u64,
    file_id: String,
    staged: bool,
    state: State<'_, AppState>,
) -> git::Result<Preview> {
    task(state, false, move |b| {
        b.working_diff(repo_id, &file_id, staged)
    })
    .await
}
#[tauri::command]
async fn stage_files(
    repo_id: u64,
    file_ids: Vec<String>,
    unstage: bool,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.stage(repo_id, &file_ids, unstage, &token)
    })
    .await
}
#[tauri::command]
async fn create_commit(
    repo_id: u64,
    message: String,
    token: String,
    detached_ok: bool,
    bump: Option<String>,
    amend: bool,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.commit(repo_id, &message, &token, detached_ok, bump, amend)
    })
    .await
}
#[tauri::command]
async fn create_branch(
    repo_id: u64,
    name: String,
    oid: Option<String>,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.create_branch(repo_id, &name, oid, &token)
    })
    .await
}
#[tauri::command]
async fn switch_branch(
    repo_id: u64,
    reference_id: String,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.switch_branch(repo_id, &reference_id, &token)
    })
    .await
}
#[tauri::command]
async fn rename_branch(
    repo_id: u64,
    reference_id: String,
    name: String,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.rename_branch(repo_id, &reference_id, &name, &token)
    })
    .await
}
#[tauri::command]
async fn delete_branch(
    repo_id: u64,
    reference_id: String,
    force: bool,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.delete_branch(repo_id, &reference_id, force, &token)
    })
    .await
}
#[tauri::command]
async fn fetch_remote(
    repo_id: u64,
    remote_id: String,
    on_progress: Channel<String>,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    let progress: Progress = Arc::new(move |message| {
        let _ = on_progress.send(message);
    });
    task(state, true, move |b| {
        b.fetch(repo_id, &remote_id, Some(progress))
    })
    .await
}
#[tauri::command]
async fn pull_remote(
    repo_id: u64,
    token: String,
    on_progress: Channel<String>,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    let progress: Progress = Arc::new(move |message| {
        let _ = on_progress.send(message);
    });
    task(state, true, move |b| {
        b.pull(repo_id, &token, Some(progress))
    })
    .await
}
#[tauri::command]
async fn push_remote(
    repo_id: u64,
    remote_id: Option<String>,
    token: String,
    on_progress: Channel<String>,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    let progress: Progress = Arc::new(move |message| {
        let _ = on_progress.send(message);
    });
    task(state, true, move |b| {
        b.push(repo_id, remote_id, &token, Some(progress))
    })
    .await
}

#[tauri::command]
async fn get_session(repo_id: u64, state: State<'_, AppState>) -> git::Result<Session> {
    task(state, false, move |b| b.session(repo_id)).await
}
#[tauri::command]
async fn get_session_diff(
    repo_id: u64,
    path: String,
    state: State<'_, AppState>,
) -> git::Result<Preview> {
    task(state, false, move |b| b.session_diff(repo_id, &path)).await
}
#[tauri::command]
async fn undo_files(
    repo_id: u64,
    paths: Vec<String>,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.undo_files(repo_id, &paths, &token)).await
}
#[tauri::command]
async fn get_health(repo_id: u64, state: State<'_, AppState>) -> git::Result<Vec<String>> {
    task(state, false, move |b| b.health(repo_id)).await
}
#[tauri::command]
async fn start_experiment(
    repo_id: u64,
    name: String,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.start_experiment(repo_id, &name, &token)
    })
    .await
}
#[tauri::command]
async fn finish_experiment(
    repo_id: u64,
    keep: bool,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.finish_experiment(repo_id, keep, &token)
    })
    .await
}
#[tauri::command]
async fn resolve_conflict(
    repo_id: u64,
    file_id: String,
    choice: String,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.resolve_conflict(repo_id, &file_id, &choice, &token)
    })
    .await
}
#[tauri::command]
async fn finish_operation(
    repo_id: u64,
    abort: bool,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.finish_operation(repo_id, abort, &token)
    })
    .await
}
#[tauri::command]
async fn undo_commit(
    repo_id: u64,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.undo_commit(repo_id, &token)).await
}
#[tauri::command]
async fn publish(
    repo_id: u64,
    main: String,
    url: Option<String>,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.publish(repo_id, &main, url.as_deref(), &token)
    })
    .await
}
#[tauri::command]
async fn get_agent_rules(repo_id: u64, state: State<'_, AppState>) -> git::Result<String> {
    task(state, false, move |b| b.agent_rules(repo_id)).await
}
#[tauri::command]
async fn save_agent_rules(
    repo_id: u64,
    rules: String,
    state: State<'_, AppState>,
) -> git::Result<()> {
    task(state, true, move |b| b.save_agent_rules(repo_id, &rules)).await
}
#[tauri::command]
async fn ask_claude(
    repo_id: u64,
    request: String,
    scope: String,
    state: State<'_, AppState>,
) -> git::Result<assist::Answer> {
    let changes = task(state, false, move |b| b.change_text(repo_id, &scope)).await?;
    // The Claude request runs outside the repository lock so Git actions stay responsive.
    tauri::async_runtime::spawn_blocking(move || assist::ask(&request, &changes))
        .await
        .map_err(|e| format!("Claude task failed: {e}"))?
}
#[tauri::command]
fn get_ai_provider() -> assist::Provider {
    assist::public_provider()
}
#[tauri::command]
fn save_ai_provider(provider: assist::Provider) -> git::Result<()> {
    assist::save_provider(provider)
}
#[tauri::command]
async fn set_api_key(key: String) -> git::Result<()> {
    assist::save_key(&key)
}
#[tauri::command]
async fn run_project(
    repo_id: u64,
    on_output: Channel<String>,
    state: State<'_, AppState>,
) -> git::Result<String> {
    let root = task(state, false, move |b| b.root(repo_id)).await?;
    tauri::async_runtime::spawn_blocking(move || {
        runner::run(&root, |line| {
            let _ = on_output.send(line);
        })
    })
    .await
    .map_err(|e| format!("Run task failed: {e}"))?
}
#[tauri::command]
fn stop_project() -> git::Result<()> {
    runner::stop()
}

#[tauri::command]
async fn list_stashes(repo_id: u64, state: State<'_, AppState>) -> git::Result<Vec<Stash>> {
    task(state, false, move |b| b.stashes(repo_id)).await
}
#[tauri::command]
async fn save_stash(
    repo_id: u64,
    message: String,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.stash_save(repo_id, &message, &token)
    })
    .await
}
#[tauri::command]
async fn apply_stash(
    repo_id: u64,
    index: u32,
    message: String,
    pop: bool,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.stash_apply(repo_id, index, &message, pop, &token)
    })
    .await
}
#[tauri::command]
async fn drop_stash(
    repo_id: u64,
    index: u32,
    message: String,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.stash_drop(repo_id, index, &message, &token)
    })
    .await
}
#[tauri::command]
async fn clone_repository(
    url: String,
    parent: String,
    on_progress: Channel<String>,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    let progress: Progress = Arc::new(move |message| {
        let _ = on_progress.send(message);
    });
    task(state, true, move |b| b.clone(&url, &parent, Some(progress))).await
}
#[tauri::command]
async fn checkout_remote(
    repo_id: u64,
    reference_id: String,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.checkout_remote(repo_id, &reference_id, &token)
    })
    .await
}
#[tauri::command]
async fn stage_hunk(
    repo_id: u64,
    file_id: String,
    hunk: usize,
    header: String,
    unstage: bool,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.stage_hunk(repo_id, &file_id, hunk, &header, unstage, &token)
    })
    .await
}
#[tauri::command]
async fn discard_files(
    repo_id: u64,
    file_ids: Vec<String>,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.discard(repo_id, &file_ids, &token)).await
}
#[tauri::command]
async fn get_conflict(
    repo_id: u64,
    file_id: String,
    state: State<'_, AppState>,
) -> git::Result<String> {
    task(state, false, move |b| b.conflict_text(repo_id, &file_id)).await
}
#[tauri::command]
async fn save_resolution(
    repo_id: u64,
    file_id: String,
    content: String,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.save_resolution(repo_id, &file_id, &content, &token)
    })
    .await
}
#[tauri::command]
async fn list_junk(repo_id: u64, state: State<'_, AppState>) -> git::Result<Vec<Junk>> {
    task(state, false, move |b| b.junk(repo_id)).await
}
#[tauri::command]
async fn delete_junk(
    repo_id: u64,
    ids: Vec<String>,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.delete_junk(repo_id, &ids, &token)).await
}
#[tauri::command]
async fn compact_repository(repo_id: u64, state: State<'_, AppState>) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.compact(repo_id)).await
}
const RELEASES: &str = "https://github.com/MDHaarith/GitGUI/releases";
/// Newest published release as (version, page URL), read from the GitHub API through curl.
#[tauri::command]
async fn latest_release() -> git::Result<Option<(String, String)>> {
    tauri::async_runtime::spawn_blocking(|| {
        let output = std::process::Command::new("curl")
            .args([
                "-sSf",
                "--max-time",
                "15",
                "-H",
                "accept: application/vnd.github+json",
            ])
            .arg("https://api.github.com/repos/MDHaarith/GitGUI/releases/latest")
            .env_remove("LD_LIBRARY_PATH")
            .env_remove("LD_PRELOAD")
            .output()
            .map_err(|_| "Install curl to check for updates.".to_owned())?;
        if !output.status.success() {
            return Ok(None);
        }
        let release: serde_json::Value =
            serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
        let tag = release["tag_name"].as_str().unwrap_or_default();
        let url = release["html_url"].as_str().unwrap_or(RELEASES);
        Ok((!tag.is_empty() && url.starts_with(RELEASES))
            .then(|| (tag.trim_start_matches('v').to_owned(), url.to_owned())))
    })
    .await
    .map_err(|e| format!("Update check failed: {e}"))?
}
/// Opens a GitGUI release page in the browser; other URLs are refused.
#[tauri::command]
fn open_release(url: String) -> git::Result<()> {
    if !url.starts_with(RELEASES) || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Only GitGUI release pages can be opened.".into());
    }
    std::process::Command::new("xdg-open")
        .arg(&url)
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("LD_PRELOAD")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Cannot open the browser: {e}. Visit {url}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            startup_path,
            open_repository,
            init_repository,
            enable_versioning,
            list_checkpoints,
            save_checkpoint,
            restore_checkpoint,
            get_status,
            get_graph,
            get_commit,
            get_commit_diff,
            get_working_diff,
            stage_files,
            create_commit,
            create_branch,
            switch_branch,
            rename_branch,
            delete_branch,
            fetch_remote,
            pull_remote,
            push_remote,
            get_session,
            get_session_diff,
            undo_files,
            get_health,
            start_experiment,
            finish_experiment,
            resolve_conflict,
            finish_operation,
            undo_commit,
            publish,
            get_agent_rules,
            save_agent_rules,
            ask_claude,
            set_api_key,
            get_ai_provider,
            save_ai_provider,
            run_project,
            stop_project,
            list_stashes,
            save_stash,
            apply_stash,
            drop_stash,
            clone_repository,
            checkout_remote,
            stage_hunk,
            discard_files,
            get_conflict,
            save_resolution,
            list_junk,
            delete_junk,
            compact_repository,
            latest_release,
            open_release
        ])
        .run(tauri::generate_context!())
        .expect("Could not run GitGUI");
}
