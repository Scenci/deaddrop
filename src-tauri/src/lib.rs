// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use ssh2::Session;
use ssh2::OpenFlags;
use std::net::TcpStream;
use std::sync::Mutex;
use tauri::State;
use serde::Serialize;
use std::io::Read;
use std::fs::File;
use std::io::Write;
use std::path::Path;

#[derive(Serialize)]
struct FileEntry {
    name: String,
    is_dir: bool,
    size: u64, //maybe ask why later?
}

struct AppState {
    session: Mutex<Option<Session>>,
}

#[tauri::command]
fn ping() -> String {
    "pong".into()
}
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use std::time::Duration;

#[tauri::command]
fn connect(
    host: String,
    port: u16,
    username: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Create socket address
    let address = format!("{}:{}", host, port);
    
    // Connect with 5-second timeout
    let tcp = TcpStream::connect_timeout(
        &address.parse().map_err(|e: std::net::AddrParseError| e.to_string())?,
        Duration::from_secs(5)
    ).map_err(|e| format!("Connection failed: {}", e))?;
    
    // Set read/write timeouts too
    tcp.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;

    let mut session = Session::new().map_err(|e| e.to_string())?;
    session.set_tcp_stream(tcp);
    session.handshake().map_err(|e| format!("Handshake failed: {}", e))?;
    session.userauth_password(&username, &password)
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
fn list_dir(
    path: String,
    state: State<'_, AppState>
    ) -> Result<Vec<FileEntry>, String> {
    
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;

    let sftp = session.sftp().map_err(|e| e.to_string())?;
    let entries = sftp.readdir(std::path::Path::new(&path)).map_err(|e| e.to_string())?;


    // Used AI to improve this code; it's confusing for everyone.
    let files: Vec<FileEntry> = entries
        .iter()
        .map(|(pathbuf, stat)|{
            FileEntry {
                name: pathbuf
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                is_dir: stat.is_dir(),
                size: stat.size.unwrap_or(0),
            }
        })
        .collect();

    Ok(files)
}

#[tauri::command]
fn download_file(remote_path: String, local_path: String, state: State<'_, AppState>,) -> Result<String,String> {

    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    //Open the files
    let mut remote_file = sftp.open(Path::new(&remote_path)).map_err(|e| e.to_string())?;

    //Read the files
    let mut contents = Vec::new();
    remote_file.read_to_end(&mut contents).map_err(|e| e.to_string())?;

    //Write (download) to local files
    let mut local_file = File::create(&local_path).map_err(|e| e.to_string())?;
    local_file.write_all(&contents).map_err(|e| e.to_string())?;

    //Where does this write? Console?
    Ok(format!("Donwload {} bytes", contents.len()))
}
use tauri::{Emitter, Window};

#[derive(Clone, Serialize)]
struct UploadProgress {
    file_name: String,
    bytes_sent: u64,
    total_bytes: u64,
    percent: u8,
}

#[tauri::command]
fn upload_file(
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
    window: Window,
) -> Result<String, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    // Get file name for progress reporting
    let file_name = Path::new(&local_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    // Open local file and get size
    let mut local_file = std::fs::File::open(&local_path)
        .map_err(|e| format!("Failed to open local file: {}", e))?;
    
    let total_bytes = local_file.metadata()
        .map_err(|e| e.to_string())?
        .len();

    // Create remote file
    let mut remote_file = sftp
        .open_mode(
            Path::new(&remote_path),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            0o644,
            ssh2::OpenType::File,
        )
        .map_err(|e| format!("Failed to create remote file: {}", e))?;

    // Upload in chunks (64KB)
    let chunk_size = 64 * 1024;
    let mut buffer = vec![0u8; chunk_size];
    let mut bytes_sent: u64 = 0;
    let mut last_percent: u8 = 0;

    loop {
        let bytes_read = local_file.read(&mut buffer).map_err(|e| e.to_string())?;
        
        if bytes_read == 0 {
            break; // EOF
        }

        remote_file
            .write_all(&buffer[..bytes_read])
            .map_err(|e| format!("Failed to write: {}", e))?;

        bytes_sent += bytes_read as u64;
        
        // Calculate progress
        let percent = ((bytes_sent as f64 / total_bytes as f64) * 100.0) as u8;
        
        // Only emit if percent changed (avoid flooding)
        if percent != last_percent {
            last_percent = percent;
            let _ = window.emit("upload-progress", UploadProgress {
                file_name: file_name.clone(),
                bytes_sent,
                total_bytes,
                percent,
            });
        }
    }

    Ok(format!("Uploaded {} bytes", bytes_sent))
}

#[tauri::command]
fn delete_file(remote_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    let path = Path::new(&remote_path);
    
    // Check if it's a directory or file
    let stat = sftp.stat(path).map_err(|e| format!("Failed to stat: {}", e))?;
    
    if stat.is_dir() {
        sftp.rmdir(path).map_err(|e| format!("Failed to delete directory: {}", e))?;
        Ok("Directory deleted".into())
    } else {
        sftp.unlink(path).map_err(|e| format!("Failed to delete file: {}", e))?;
        Ok("File deleted".into())
    }
}

// Let's never touch this besides when updating it for our new components/functions (im not a rust expert)
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // NO drag-drop plugin needed
        .manage(AppState {
            session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![ping, connect, list_dir, download_file, upload_file, delete_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

