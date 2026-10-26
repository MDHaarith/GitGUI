#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The AppImage launcher points these at its bundle; child tools (python, perl) then fail to start.
    for var in ["PYTHONHOME", "PYTHONPATH", "PERLLIB"] {
        std::env::remove_var(var);
    }
    // Apps opened from Finder get a bare PATH without Homebrew or ~/.local/bin, so gh and AI agents go missing.
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        let mut paths = vec![
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
            std::path::PathBuf::from(home).join(".local/bin"),
        ];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        if let Ok(path) = std::env::join_paths(paths) {
            std::env::set_var("PATH", path);
        }
    }
    gitgui_lib::run();
}
