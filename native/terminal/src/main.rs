//! One process per terminal. stdin is bounded JSONL control; stdout is raw PTY
//! output; stderr is JSONL status. No listener, daemon, or retained sessions.
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Deserialize;
use serde_json::json;
use std::io::{self, BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const PROTOCOL: u32 = 1;
const MAX_FRAME: u64 = 256 * 1024;
const MAX_INPUT: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Command {
    Spawn {
        protocol: u32,
        file: String,
        args: Vec<String>,
        cwd: String,
        cols: u16,
        rows: u16,
    },
    Write {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Kill {},
}

fn status(value: serde_json::Value) -> io::Result<()> {
    let mut out = io::stderr().lock();
    serde_json::to_writer(&mut out, &value)?;
    out.write_all(b"\n")?;
    out.flush()
}

fn read_command(reader: &mut impl BufRead) -> Result<Option<Command>, &'static str> {
    let mut frame = Vec::new();
    // Limit allocation even if the sender never supplies a newline.
    let length = (&mut *reader)
        .take(MAX_FRAME + 1)
        .read_until(b'\n', &mut frame)
        .map_err(|_| "control-read")?;
    if length == 0 {
        return Ok(None);
    }
    if length as u64 > MAX_FRAME || frame.last() != Some(&b'\n') {
        return Err("control-frame");
    }
    serde_json::from_slice(&frame)
        .map(Some)
        .map_err(|_| "control-json")
}

fn size(cols: u16, rows: u16) -> Result<PtySize, &'static str> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        return Err("terminal-size");
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn process_cwd(pid: u32) -> Option<std::path::PathBuf> {
    let mut system = System::new().ok()?;
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        false,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    system.process(pid)?.cwd().map(std::path::Path::to_path_buf)
}

fn signal_group(group: i32, signal: i32) {
    if group > 1 {
        // The PTY child creates a new session. Only its process group and the
        // foreground group of this owned PTY are ever signalled.
        unsafe {
            libc::kill(-group, signal);
        }
    }
}

fn serve() -> Result<(), &'static str> {
    let stopping = Arc::new(AtomicBool::new(false));
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        signal_hook::flag::register(signal, stopping.clone()).map_err(|_| "signal-handler")?;
    }
    let (commands_tx, commands_rx) = mpsc::sync_channel(8);
    let input_stopped = stopping.clone();
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            match read_command(&mut input) {
                Ok(Some(command)) => {
                    if commands_tx.send(Ok(command)).is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    input_stopped.store(true, Ordering::SeqCst);
                    return;
                }
                Err(error) => {
                    let _ = commands_tx.send(Err(error));
                    return;
                }
            }
        }
    });
    let command = commands_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "startup-timeout")??;
    let Command::Spawn {
        protocol,
        file,
        args,
        cwd,
        cols,
        rows,
    } = command
    else {
        return Err("spawn-required");
    };
    if protocol != PROTOCOL {
        return Err("protocol-version");
    }
    if stopping.load(Ordering::SeqCst) {
        return Err("parent-disconnected");
    }
    let pair = native_pty_system()
        .openpty(size(cols, rows)?)
        .map_err(|_| "pty-open")?;
    let mut reader = pair.master.try_clone_reader().map_err(|_| "pty-reader")?;
    let mut writer = pair.master.take_writer().map_err(|_| "pty-writer")?;
    let mut command = CommandBuilder::new(file);
    command.args(args);
    command.cwd(cwd);
    // Inherit the exact filtered environment supplied by Node, including HOME,
    // XDG_CONFIG_HOME, PATH and SSH_AUTH_SOCK. OpenSSH owns SSH configuration.
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|_| "spawn-failed")?;
    drop(pair.slave);
    let pid = child.process_id().unwrap_or(0);
    let (output_done_tx, output_done_rx) = mpsc::channel();
    let output_stopped = stopping.clone();
    thread::spawn(move || {
        let mut copy_output = || -> io::Result<()> {
            let mut out = io::stdout().lock();
            let mut buffer = [0; 8192];
            loop {
                let count = match reader.read(&mut buffer) {
                    Ok(0) => return Ok(()),
                    Ok(count) => count,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                };
                out.write_all(&buffer[..count])?;
                out.flush()?;
            }
        };
        if copy_output().is_err() {
            output_stopped.store(true, Ordering::SeqCst);
        }
        let _ = output_done_tx.send(());
    });
    let (writes_tx, writes_rx) = mpsc::sync_channel::<String>(8);
    let writer_stopped = stopping.clone();
    thread::spawn(move || {
        while let Ok(data) = writes_rx.recv() {
            if writer.write_all(data.as_bytes()).is_err() {
                writer_stopped.store(true, Ordering::SeqCst);
                break;
            }
        }
    });

    let mut failure = status(json!({ "type": "ready", "protocol": PROTOCOL, "pid": pid }))
        .err()
        .map(|_| "parent-disconnected");
    let mut exit_code = None;
    while failure.is_none() && !stopping.load(Ordering::SeqCst) {
        match child.try_wait() {
            Ok(Some(exit)) => {
                exit_code = Some(exit.exit_code());
                break;
            }
            Err(_) => {
                failure = Some("process-wait");
                break;
            }
            Ok(None) => {}
        }
        let result = match commands_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Ok(Command::Write { data })) if data.len() <= MAX_INPUT => {
                writes_tx.try_send(data).map_err(|_| "input-overflow")
            }
            Ok(Ok(Command::Resize { cols, rows })) => {
                size(cols, rows).and_then(|size| pair.master.resize(size).map_err(|_| "pty-resize"))
            }
            Ok(Ok(Command::Kill {})) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Ok(Ok(_)) => Err("invalid-command"),
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(()),
        };
        failure = result.err();
    }

    // Close the foreground job as well as the shell/ssh group. Escalate even if
    // the shell exits first; a foreground program may ignore SIGHUP.
    let foreground = pair.master.process_group_leader().unwrap_or(0);
    signal_group(foreground, libc::SIGHUP);
    signal_group(pid as i32, libc::SIGHUP);
    let deadline = Instant::now() + Duration::from_millis(250);
    while Instant::now() < deadline {
        if exit_code.is_none()
            && let Ok(Some(exit)) = child.try_wait()
        {
            exit_code = Some(exit.exit_code());
        }
        thread::sleep(Duration::from_millis(10));
    }
    signal_group(foreground, libc::SIGKILL);
    signal_group(pid as i32, libc::SIGKILL);
    let _ = child.kill();
    if exit_code.is_none() {
        exit_code = child.wait().ok().map(|exit| exit.exit_code());
    }
    drop(writes_tx);
    drop(pair.master);
    // Drain bytes written just before exit before reporting it to Node. Bound
    // this wait for a parent that stopped reading or a detached descendant.
    let _ = output_done_rx.recv_timeout(Duration::from_secs(2));
    if let Some(code) = failure {
        let _ = status(json!({ "type": "error", "code": code }));
    }
    let _ = status(json!({ "type": "exit", "exitCode": exit_code.unwrap_or(1) }));
    Ok(())
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!(
            "{}",
            json!({ "name": "web-terminal-pty", "protocol": PROTOCOL, "version": env!("CARGO_PKG_VERSION") })
        );
        return;
    }
    if let [mode, pid] = args.as_slice()
        && mode == "cwd"
    {
        if let Some(cwd) = pid
            .parse::<u32>()
            .ok()
            .filter(|pid| *pid > 0)
            .and_then(process_cwd)
            .and_then(|cwd| cwd.to_str().map(str::to_owned))
        {
            println!("{}", json!({ "cwd": cwd }));
            return;
        }
        std::process::exit(1);
    }
    if !args.is_empty() {
        std::process::exit(2);
    }
    if let Err(code) = serve() {
        let _ = status(json!({ "type": "error", "code": code }));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_frames_are_bounded_and_complete() {
        assert!(read_command(&mut io::Cursor::new(vec![b'x'; MAX_FRAME as usize + 1])).is_err());
        assert!(read_command(&mut io::Cursor::new(b"{\"type\":\"kill\"}")).is_err());
        assert!(matches!(
            read_command(&mut io::Cursor::new(b"{\"type\":\"kill\"}\n")),
            Ok(Some(Command::Kill {}))
        ));
        assert!(read_command(&mut io::Cursor::new(b"{\"type\":\"kill\",\"extra\":1}\n")).is_err());
    }
}
