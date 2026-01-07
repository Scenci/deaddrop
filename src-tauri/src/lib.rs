use ssh2::{OpenFlags, Session};
use std::fs;
use std::io::Read;
use std::io::Write;
use std::net::TcpStream;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, State, Window};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

struct AppState {
    session: Mutex<Option<Session>>,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

#[derive(Clone, Serialize)]
struct UploadProgress {
    file_name: String,
    local_path: String,  // ADD THIS
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

// ============ LOCAL FILE SYSTEM COMMANDS ============

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not find home directory".to_string())
}

#[tauri::command]
fn list_local_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut files: Vec<FileEntry> = Vec::new();

    for entry in entries {
        if let Ok(entry) = entry {
            let metadata = entry.metadata();
            let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

            files.push(FileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                is_dir,
                size,
            });
        }
    }

    Ok(files)
}

#[tauri::command]
fn create_local_directory(path: String) -> Result<String, String> {
    fs::create_dir(&path).map_err(|e| format!("Failed to create directory: {}", e))?;
    Ok("Directory created".into())
}

#[tauri::command]
fn delete_local_file(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path).map_err(|e| format!("Failed to stat: {}", e))?;

    if metadata.is_dir() {
        fs::remove_dir(&path).map_err(|e| format!("Failed to delete directory: {}", e))?;
        Ok("Directory deleted".into())
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))?;
        Ok("File deleted".into())
    }
}

#[tauri::command]
fn local_file_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

// ============ REMOTE (SSH/SFTP) COMMANDS ============

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
fn disconnect(state: State<'_, AppState>) -> Result<String, String> {
    let mut stored_session = state.session.lock().map_err(|e| e.to_string())?;
    *stored_session = None;
    Ok("Disconnected".into())
}

#[tauri::command]
fn is_connected(state: State<'_, AppState>) -> Result<bool, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    Ok(session_guard.is_some())
}

#[tauri::command]
fn list_remote_dir(path: String, state: State<'_, AppState>) -> Result<Vec<FileEntry>, String> {
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

    let mut local_file = fs::File::create(&local_path).map_err(|e| e.to_string())?;
    local_file
        .write_all(&contents)
        .map_err(|e| e.to_string())?;

    Ok(format!("Downloaded {} bytes", contents.len()))
}

#[tauri::command]
fn delete_remote_file(remote_path: String, state: State<'_, AppState>) -> Result<String, String> {
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

#[tauri::command]
fn remote_file_exists(remote_path: String, state: State<'_, AppState>) -> Result<bool, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    match sftp.stat(Path::new(&remote_path)) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
fn create_remote_directory(remote_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    sftp.mkdir(Path::new(&remote_path), 0o755)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    Ok("Directory created".into())
}

#[tauri::command(async)]
async fn upload_file(
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
    window: Window,
) -> Result<String, String> {
    let file_name = Path::new(&local_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let metadata = fs::metadata(&local_path)
        .map_err(|e| format!("Failed to read local file: {}", e))?;
    let total_bytes = metadata.len();

    let local_path_clone = local_path.clone();
    let remote_path_clone = remote_path.clone();
    let file_name_clone = file_name.clone();
    let window_clone = window.clone();

    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("Not Connected")?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;

    let mut local_file = fs::File::open(&local_path_clone)
        .map_err(|e| format!("Failed to open local file: {}", e))?;

    let mut remote_file = sftp
        .open_mode(
            Path::new(&remote_path_clone),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            0o644,
            ssh2::OpenType::File,
        )
        .map_err(|e| format!("Failed to create remote file: {}", e))?;

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

        // Only emit every 2% to reduce overhead
        if percent != last_percent && percent % 2 == 0 {
            last_percent = percent;
            let _ = window_clone.emit(
                "upload-progress",
                UploadProgress {
                    file_name: file_name_clone.clone(),
                    local_path: local_path_clone.clone(),
                    bytes_sent,
                    total_bytes,
                    percent,
                },
            );
        }
    }

    Ok(format!("Uploaded {} bytes", bytes_sent))
}

#[derive(Serialize)]
struct LocalFileInfo {
    absolute_path: String,
    relative_path: String,
    is_dir: bool,
}

#[tauri::command]
fn list_local_dir_recursive(path: String) -> Result<Vec<LocalFileInfo>, String> {
    let base_path = Path::new(&path);
    let mut results: Vec<LocalFileInfo> = Vec::new();
    
    fn walk_dir(dir: &Path, base: &Path, results: &mut Vec<LocalFileInfo>) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
        
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                let relative = path.strip_prefix(base)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string();
                
                let is_dir = path.is_dir();
                
                results.push(LocalFileInfo {
                    absolute_path: path.to_string_lossy().to_string(),
                    relative_path: relative,
                    is_dir,
                });
                
                if is_dir {
                    walk_dir(&path, base, results)?;
                }
            }
        }
        Ok(())
    }
    
    // Add the root directory itself
    let dir_name = base_path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    
    results.push(LocalFileInfo {
        absolute_path: path.clone(),
        relative_path: dir_name.clone(),
        is_dir: true,
    });
    
    walk_dir(base_path, base_path.parent().unwrap_or(base_path), &mut results)?;
    
    Ok(results)
}

#[tauri::command]
fn is_directory(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).is_dir())
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
            // Local
            get_home_dir,
            list_local_dir,
            list_local_dir_recursive,
            create_local_directory,
            delete_local_file,
            local_file_exists,
            is_directory,
            // Remote
            connect,
            disconnect,
            is_connected,
            list_remote_dir,
            download_file,
            upload_file,
            delete_remote_file,
            remote_file_exists,
            create_remote_directory,
            // Profiles
            get_profiles,
            save_profile,
            delete_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Serialize, Deserialize, Clone)]
struct ConnectionProfile {
    name: String,
    host: String,
    port: u16,
    username: String,
}

#[derive(Serialize, Deserialize)]
struct ProfilesData {
    profiles: Vec<ConnectionProfile>,
}

fn get_profiles_path() -> Result<PathBuf, String> {
    let app_data = dirs::config_dir()
        .ok_or_else(|| "Could not find config directory".to_string())?;
    
    let deaddrop_dir = app_data.join("deaddrop");
    
    // Create directory if it doesn't exist
    if !deaddrop_dir.exists() {
        fs::create_dir_all(&deaddrop_dir)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    
    Ok(deaddrop_dir.join("profiles.json"))
}

#[tauri::command]
fn get_profiles() -> Result<Vec<ConnectionProfile>, String> {
    let path = get_profiles_path()?;
    
    if !path.exists() {
        return Ok(Vec::new());
    }
    
    let contents = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read profiles: {}", e))?;
    
    let data: ProfilesData = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse profiles: {}", e))?;
    
    Ok(data.profiles)
}

#[tauri::command]
fn save_profile(name: String, host: String, port: u16, username: String) -> Result<String, String> {
    let path = get_profiles_path()?;
    
    let mut profiles = get_profiles().unwrap_or_default();
    
    // Check if profile with same name exists, update it
    if let Some(existing) = profiles.iter_mut().find(|p| p.name == name) {
        existing.host = host;
        existing.port = port;
        existing.username = username;
    } else {
        // Check max profiles limit
        if profiles.len() >= 3 {
            return Err("Maximum of 3 profiles allowed. Delete one first.".to_string());
        }
        
        profiles.push(ConnectionProfile {
            name,
            host,
            port,
            username,
        });
    }
    
    let data = ProfilesData { profiles };
    let json = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize profiles: {}", e))?;
    
    fs::write(&path, json)
        .map_err(|e| format!("Failed to write profiles: {}", e))?;
    
    Ok("Profile saved".to_string())
}

#[tauri::command]
fn delete_profile(name: String) -> Result<String, String> {
    let path = get_profiles_path()?;
    
    let mut profiles = get_profiles().unwrap_or_default();
    profiles.retain(|p| p.name != name);
    
    let data = ProfilesData { profiles };
    let json = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize profiles: {}", e))?;
    
    fs::write(&path, json)
        .map_err(|e| format!("Failed to write profiles: {}", e))?;
    
    Ok("Profile deleted".to_string())
}