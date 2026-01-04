use ssh2::{OpenFlags, Session};
use std::io::Read;
use std::io::Write;
use std::net::TcpStream;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, State, Window};
use serde::Serialize;

// Session wrapper that can be sent between threads
struct AppState {
    session: Mutex<Option<Session>>,
}

// Required for async commands with State
unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

#[derive(Clone, Serialize)]
struct UploadProgress {
    file_name: String,
    bytes_sent: u64,
    total_bytes: u64,
    percent: u8,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    is_dir: bool,
    size: u64,
}

#[tauri::command]
fn ping() -> String {
    "pong".into()
}

#[tauri::command]
fn connect(
    host: String,
    port: u16,
    username: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let address = format!("{}:{}", host, port);

    let tcp = TcpStream::connect_timeout(
        &address
            .parse()
            .map_err(|e: std::net::AddrParseError| e.to_string())?,
        Duration::from_secs(5),
    )
    .map_err(|e| format!("Connection failed: {}", e))?;

    tcp.set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;

    let mut session = Session::new().map_err(|e| e.to_string())?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("Handshake failed: {}", e))?;

    // Enable keepalive
    session.set_keepalive(true, 60);

    session
        .userauth_password(&username, &password)
        .map_err(|e| format!("Authentication failed: {}", e))?;

    if session.authenticated() {
        let mut stored_session = state.session.lock().map_err(|e| e.to_string())?;
        *stored_session = Some(session);
        Ok("Authentication Successful".into())
    } else {
        Err("Authentication failed: Invalid credentials".into())
    }
}

#[tauri::command]
fn list_dir(path: String, state: State<'_, AppState>) -> Result<Vec<FileEntry>, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not connected")?;

    let sftp = session.sftp().map_err(|e| e.to_string())?;
    let entries = sftp
        .readdir(Path::new(&path))
        .map_err(|e| e.to_string())?;

    let files: Vec<FileEntry> = entries
        .iter()
        .map(|(pathbuf, stat)| FileEntry {
            name: pathbuf
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            is_dir: stat.is_dir(),
            size: stat.size.unwrap_or(0),
        })
        .collect();

    Ok(files)
}

#[tauri::command]
fn download_file(
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not connected")?;

    let sftp = session.sftp().map_err(|e| e.to_string())?;

    let mut remote_file = sftp
        .open(Path::new(&remote_path))
        .map_err(|e| e.to_string())?;

    let mut contents = Vec::new();
    remote_file
        .read_to_end(&mut contents)
        .map_err(|e| e.to_string())?;

    let mut local_file = std::fs::File::create(&local_path).map_err(|e| e.to_string())?;
    local_file
        .write_all(&contents)
        .map_err(|e| e.to_string())?;

    Ok(format!("Downloaded {} bytes", contents.len()))
}

#[tauri::command]
fn delete_file(remote_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    let path = Path::new(&remote_path);

    let stat = sftp
        .stat(path)
        .map_err(|e| format!("Failed to stat: {}", e))?;

    if stat.is_dir() {
        sftp.rmdir(path)
            .map_err(|e| format!("Failed to delete directory: {}", e))?;
        Ok("Directory deleted".into())
    } else {
        sftp.unlink(path)
            .map_err(|e| format!("Failed to delete file: {}", e))?;
        Ok("File deleted".into())
    }
}

#[tauri::command(async)]
async fn upload_file(
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
    window: Window,
) -> Result<String, String> {
    // Get file info first (quick operation)
    let file_name = Path::new(&local_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let metadata = std::fs::metadata(&local_path)
        .map_err(|e| format!("Failed to read local file: {}", e))?;
    let total_bytes = metadata.len();

    // Clone what we need for the blocking task
    let local_path_clone = local_path.clone();
    let remote_path_clone = remote_path.clone();
    let file_name_clone = file_name.clone();
    let window_clone = window.clone();

    // Acquire the session lock
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    // Open local file
    let mut local_file = std::fs::File::open(&local_path_clone)
        .map_err(|e| format!("Failed to open local file: {}", e))?;

    // Create remote file
    let mut remote_file = sftp
        .open_mode(
            Path::new(&remote_path_clone),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            0o644,
            ssh2::OpenType::File,
        )
        .map_err(|e| format!("Failed to create remote file: {}", e))?;

    // Upload in chunks (1MB for speed)
    let chunk_size = 1024 * 1024;
    let mut buffer = vec![0u8; chunk_size];
    let mut bytes_sent: u64 = 0;
    let mut last_percent: u8 = 0;

    loop {
        let bytes_read = local_file
            .read(&mut buffer)
            .map_err(|e| e.to_string())?;

        if bytes_read == 0 {
            break;
        }

        remote_file
            .write_all(&buffer[..bytes_read])
            .map_err(|e| format!("Failed to write: {}", e))?;

        bytes_sent += bytes_read as u64;

        let percent = ((bytes_sent as f64 / total_bytes as f64) * 100.0) as u8;

        if percent != last_percent {
            last_percent = percent;
            let _ = window_clone.emit(
                "upload-progress",
                UploadProgress {
                    file_name: file_name_clone.clone(),
                    bytes_sent,
                    total_bytes,
                    percent,
                },
            );
        }
    }

    Ok(format!("Uploaded {} bytes", bytes_sent))
}

#[tauri::command]
fn file_exists(remote_path: String, state: State<'_, AppState>) -> Result<bool, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    match sftp.stat(Path::new(&remote_path)) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
fn create_directory(remote_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    sftp.mkdir(Path::new(&remote_path), 0o755)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    Ok("Directory created".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            connect,
            list_dir,
            download_file,
            upload_file,
            delete_file,
            file_exists,
            create_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}