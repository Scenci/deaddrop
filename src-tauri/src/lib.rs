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

#[tauri::command]
fn upload_file(
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    // Open LOCAL file
    let mut local_file = std::fs::File::open(&local_path).map_err(|e| e.to_string())?;

    // Read contents
    let mut contents = Vec::new();
    local_file.read_to_end(&mut contents).map_err(|e| e.to_string())?;

    // Create REMOTE file with proper flags and permissions (0644)
    let mut remote_file = sftp
        .open_mode(
            Path::new(&remote_path),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            0o644,
            ssh2::OpenType::File,
        )
        .map_err(|e| format!("Failed to create remote file: {}", e))?;

    remote_file
        .write_all(&contents)
        .map_err(|e| format!("Failed to write to remote file: {}", e))?;

    Ok(format!("Uploaded {} bytes", contents.len()))
}

// Let's never touch this besides when updating it for our new components/functions (im not a rust expert)
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![ping, connect, list_dir, download_file, upload_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

