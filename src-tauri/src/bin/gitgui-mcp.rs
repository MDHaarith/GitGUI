use std::{io, path::PathBuf};

fn main() {
    if let Err(error) = run() {
        eprintln!("gitgui-mcp: {}", gitgui_lib::git::redact(&error));
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    let mut repo = std::env::current_dir().map_err(|e| e.to_string())?;
    if let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            println!("Usage: gitgui-mcp [--repo <path>]\nMCP over stdio; read-only unless GITGUI_MCP_ALLOW_WRITE=1 or GITGUI_MCP_ALLOW_DESTRUCTIVE=1.");
            return Ok(());
        }
        if arg != "--repo" {
            return Err("Usage: gitgui-mcp [--repo <path>]".into());
        }
        repo = PathBuf::from(args.next().ok_or("--repo needs a path")?);
        if args.next().is_some() {
            return Err("Usage: gitgui-mcp [--repo <path>]".into());
        }
    }
    gitgui_lib::git::mcp::serve(io::stdin().lock(), io::stdout().lock(), &repo)
        .map_err(|e| e.to_string())
}
