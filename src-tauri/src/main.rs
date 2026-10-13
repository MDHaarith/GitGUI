#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The AppImage launcher points these at its bundle; child tools (python, perl) then fail to start.
    for var in ["PYTHONHOME", "PYTHONPATH", "PERLLIB"] {
        std::env::remove_var(var);
    }
    gitgui_lib::run();
}
