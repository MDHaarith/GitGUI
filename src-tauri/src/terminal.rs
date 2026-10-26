//! One local shell per open repository; all terminal data stays outside the Git log.
use crate::git::Result;
use portable_pty::{Child, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Output {
    Data(Vec<u8>),
    Exit(String),
}

struct Session {
    generation: Arc<()>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    input: mpsc::SyncSender<Vec<u8>>,
    ack: mpsc::SyncSender<()>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            #[cfg(unix)]
            if let Some(group) = self.master.process_group_leader().filter(|g| *g > 0) {
                unsafe {
                    libc::kill(-group, libc::SIGHUP);
                }
            }
            if let Some(pid) = self.child.process_id() {
                crate::platform::kill_tree(pid);
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<u64, Session>>);

pub(crate) fn size(cols: u16, rows: u16) -> Result<PtySize> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err("Terminal dimensions must be between 2–1000 columns and 1–1000 rows.".into());
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

impl Terminals {
    pub fn start(
        self: &Arc<Self>,
        id: u64,
        root: &Path,
        cols: u16,
        rows: u16,
        output: impl Fn(Output) -> bool + Send + 'static,
    ) -> Result<()> {
        let dimensions = size(cols, rows)?;
        let mut sessions = self.0.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&id) {
            return Err("This repository already has a terminal.".into());
        }
        let pair = portable_pty::native_pty_system()
            .openpty(dimensions)
            .map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let child = crate::platform::terminal_shell(pair.slave.as_ref(), root)?;
        drop(pair.slave);
        let (input, input_rx) = mpsc::sync_channel::<Vec<u8>>(16);
        let (ack, ack_rx) = mpsc::sync_channel(1);
        let generation = Arc::new(());
        sessions.insert(
            id,
            Session {
                generation: generation.clone(),
                master: pair.master,
                child,
                input,
                ack,
            },
        );
        drop(sessions);
        thread::spawn(move || {
            while let Ok(data) = input_rx.recv() {
                if writer
                    .write_all(&data)
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        let terminals = Arc::downgrade(self);
        thread::spawn(move || {
            let mut buffer = [0; 8192];
            let end = loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break "Shell exited.".to_owned(),
                    Ok(n) => {
                        if !output(Output::Data(buffer[..n].to_vec())) {
                            break "Terminal disconnected.".to_owned();
                        }
                        // One outstanding chunk bounds IPC memory even when a command floods stdout.
                        loop {
                            match ack_rx.recv_timeout(Duration::from_secs(1)) {
                                Ok(()) => break,
                                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                            }
                        }
                    }
                    #[cfg(unix)]
                    Err(e) if e.raw_os_error() == Some(libc::EIO) => {
                        break "Shell exited.".to_owned()
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => break format!("Terminal read failed: {e}"),
                }
            };
            if let Some(terminals) = terminals.upgrade() {
                let session = {
                    let mut sessions = terminals.0.lock().unwrap_or_else(|e| e.into_inner());
                    if sessions
                        .get(&id)
                        .is_some_and(|s| Arc::ptr_eq(&s.generation, &generation))
                    {
                        sessions.remove(&id)
                    } else {
                        None
                    }
                };
                drop(session);
            }
            output(Output::Exit(end));
        });
        Ok(())
    }

    pub fn write(&self, id: u64, data: Vec<u8>) -> Result<()> {
        if data.len() > 64 * 1024 {
            return Err("Terminal input is too large.".into());
        }
        let sessions = self.0.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(&id)
            .ok_or("This terminal has exited. Reopen it to start a shell.")?;
        session
            .input
            .try_send(data)
            .map_err(|_| "Terminal input is busy; try again.".into())
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> Result<()> {
        let dimensions = size(cols, rows)?;
        let sessions = self.0.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(&id).ok_or("Terminal is closed.")?;
        session.master.resize(dimensions).map_err(|e| e.to_string())
    }

    pub fn ack(&self, id: u64) {
        if let Some(session) = self.0.lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
            let _ = session.ack.try_send(());
        }
    }

    pub fn close(&self, id: u64) {
        let session = self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        drop(session);
    }

    pub fn close_all(&self) {
        let sessions = std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()));
        drop(sessions);
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn closing_reaps_shells_even_when_output_has_not_been_acknowledged() {
        use super::*;
        let root = tempfile::tempdir().unwrap();
        let terminals = Arc::new(Terminals::default());
        let (send, recv) = mpsc::channel();
        terminals
            .start(1, root.path(), 80, 24, move |_| send.send(()).is_ok())
            .unwrap();
        let pid = terminals.0.lock().unwrap()[&1].child.process_id().unwrap();
        terminals.write(1, b"echo ready\r".to_vec()).unwrap();
        recv.recv_timeout(Duration::from_secs(10)).unwrap();
        terminals.close_all();
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }

    #[test]
    fn dimensions_are_bounded() {
        assert!(super::size(80, 24).is_ok());
        for (cols, rows) in [(0, 24), (80, 0), (1001, 24), (80, 1001)] {
            assert!(super::size(cols, rows).is_err());
        }
    }
}
