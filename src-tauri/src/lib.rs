pub mod git;
use git::{Backend, CommitDetails, GraphPage, Preview, RepoInfo};
use std::sync::{Arc, Mutex};
use tauri::State;

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
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.commit(repo_id, &message, &token, detached_ok)
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
async fn fetch_remote(
    repo_id: u64,
    remote_id: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.fetch(repo_id, &remote_id)).await
}
#[tauri::command]
async fn pull_remote(
    repo_id: u64,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.pull(repo_id, &token)).await
}
#[tauri::command]
async fn push_remote(
    repo_id: u64,
    remote_id: Option<String>,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.push(repo_id, remote_id, &token)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            startup_path,
            open_repository,
            get_status,
            get_graph,
            get_commit,
            get_commit_diff,
            get_working_diff,
            stage_files,
            create_commit,
            create_branch,
            switch_branch,
            fetch_remote,
            pull_remote,
            push_remote
        ])
        .run(tauri::generate_context!())
        .expect("Could not run GitGUI");
}
