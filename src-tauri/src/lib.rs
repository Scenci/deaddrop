// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use ssh2::Session;
use std::net::TcpStream;
use std::sync::Mutex;
use tauri::State;

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

#[tauri::command]
fn connect(
    host: String, 
    port: u16, 
    username: String, 
    password: String,
    state: State<'_, AppState>
    ) -> Result<String,String> {
    
    let tcp = TcpStream::connect(format!("{}:{}", host, port)).map_err(|e| e.to_string())?;

    let mut session = Session::new().map_err(|e| e.to_string())?;
    session.set_tcp_stream(tcp);
    session.handshake().map_err(|e| e.to_string())?;
    session.userauth_password(&username,&password).map_err(|e| e.to_string())?;

    //Step 4 check if we're authenticated
    if session.authenticated() {
        let mut stored_session = state.session.lock().map_err(|e| e.to_string())?;
        *stored_session = Some(session); //What the heck does this mean? Pointer to a session?

        Ok("Authentication Successful".into())
    } else {
        Err("Authentication Failed".into())
    }
}

#[tauri::command]
fn list_dir(
    path: String,
    state: State<'_, AppState>
    ) -> Result<Vec<String>, String> {
    
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    
    let session = session_guard.as_ref().ok_or("Not Connected")?;

    let sftp = session.sftp().map_err(|e| e.to_string())?;

    let entries = sftp.readdir(std::path::Path::new(&path)).map_err(|e| e.to_string())?;

    // Used AI to improve this code; it's confusing for everyone.
    let names: Vec<String> = entries
        .iter()
        .map(|(pathbuf, _stat)| {
            pathbuf.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        })
        .collect();

    Ok(names)
}



// Let's never touch this besides when updating it for our new components/functions (im not a rust expert)
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![greet, ping, connect, list_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

