use crate::{git, task, terminal, AppState};
use std::sync::Arc;
use tauri::{ipc::Channel, State};

#[tauri::command]
pub(crate) async fn start_terminal(
    repo_id: u64,
    cols: u16,
    rows: u16,
    on_output: Channel<terminal::Output>,
    state: State<'_, AppState>,
    terminals: State<'_, Arc<terminal::Terminals>>,
) -> git::Result<()> {
    terminal::size(cols, rows)?;
    let terminals = terminals.inner().clone();
    task(state, true, move |backend| {
        backend.checkpoint(repo_id, "Before terminal session")?;
        let root = backend.root(repo_id)?;
        terminals.start(repo_id, &root, cols, rows, move |data| {
            on_output.send(data).is_ok()
        })
    })
    .await
}

#[tauri::command]
pub(crate) fn terminal_input(
    repo_id: u64,
    data: Vec<u8>,
    terminals: State<'_, Arc<terminal::Terminals>>,
) -> git::Result<()> {
    terminals.write(repo_id, data)
}

#[tauri::command]
pub(crate) fn resize_terminal(
    repo_id: u64,
    cols: u16,
    rows: u16,
    terminals: State<'_, Arc<terminal::Terminals>>,
) -> git::Result<()> {
    terminals.resize(repo_id, cols, rows)
}

#[tauri::command]
pub(crate) fn terminal_ack(repo_id: u64, terminals: State<'_, Arc<terminal::Terminals>>) {
    terminals.ack(repo_id);
}

#[tauri::command]
pub(crate) fn stop_terminal(repo_id: u64, terminals: State<'_, Arc<terminal::Terminals>>) {
    terminals.close(repo_id);
}

#[tauri::command]
pub(crate) fn git_output_log() -> Vec<git::output_log::GitOutput> {
    git::output_log::entries()
}
