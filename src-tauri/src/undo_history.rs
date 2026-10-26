use super::*;

#[tauri::command]
pub async fn undo_action(
    repo_id: u64,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| b.undo_action(repo_id, &token)).await
}

#[tauri::command]
pub async fn undo_label(repo_id: u64, state: State<'_, AppState>) -> git::Result<Option<String>> {
    task(state, false, move |b| b.undo_label(repo_id)).await
}

#[tauri::command]
pub async fn get_reflog(
    repo_id: u64,
    state: State<'_, AppState>,
) -> git::Result<Vec<git::ReflogEntry>> {
    task(state, false, move |b| b.reflog(repo_id)).await
}

#[tauri::command]
pub async fn restore_reflog(
    repo_id: u64,
    oid: String,
    token: String,
    state: State<'_, AppState>,
) -> git::Result<RepoInfo> {
    task(state, true, move |b| {
        b.with_undo(repo_id, "Restore from time machine", |b| {
            b.restore_reflog(repo_id, &oid, &token)
        })
    })
    .await
}

#[tauri::command]
pub async fn line_history(
    repo_id: u64,
    file_id: String,
    commit: Option<String>,
    start: u32,
    end: u32,
    state: State<'_, AppState>,
) -> git::Result<Preview> {
    task(state, false, move |b| {
        b.line_history(repo_id, &file_id, commit.as_deref(), start, end)
    })
    .await
}
