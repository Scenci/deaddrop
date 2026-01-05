import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

interface UploadProgress {
  file_name: string;
  bytes_sent: number;
  total_bytes: number;
  percent: number;
}

interface QueuedFile {
  id: string;
  localPath: string;
  fileName: string;
  remotePath: string;
  status: "pending" | "uploading" | "complete" | "error";
  progress: number;
  error?: string;
}

interface DragDropEvent {
  paths: string[];
  position: { x: number; y: number };
}

// State
let localPath = "";
let remotePath = "/";
let isConnected = false;
let connectedHost = "";
let currentZoom = 1;

// Selection
let selectedLocalFiles: Set<string> = new Set();

// Upload queue
let uploadQueue: QueuedFile[] = [];
let isProcessingQueue = false;
const MAX_CONCURRENT_UPLOADS = 2;
let activeUploads = 0;

// DOM Elements
let localFileList: HTMLElement;
let remoteFileList: HTMLElement;
let localPathInput: HTMLInputElement;
let remotePathInput: HTMLInputElement;
let queueListDiv: HTMLElement;
let queueStatusSpan: HTMLElement;
let connectionModal: HTMLElement;
let connectStatus: HTMLElement;
let connectionStatusDiv: HTMLElement;
let remoteServerName: HTMLElement;
let uploadSelectedBtn: HTMLButtonElement;
let dropZone: HTMLElement;

window.addEventListener("DOMContentLoaded", async () => {
  // Get DOM elements
  localFileList = document.querySelector("#local-file-list")!;
  remoteFileList = document.querySelector("#remote-file-list")!;
  localPathInput = document.querySelector("#local-path")!;
  remotePathInput = document.querySelector("#remote-path")!;
  queueListDiv = document.querySelector("#queue-list")!;
  queueStatusSpan = document.querySelector("#queue-status")!;
  connectionModal = document.querySelector("#connection-modal")!;
  connectStatus = document.querySelector("#connect-status")!;
  connectionStatusDiv = document.querySelector("#connection-status")!;
  remoteServerName = document.querySelector("#remote-server-name")!;
  uploadSelectedBtn = document.querySelector("#upload-selected-btn")!;
  dropZone = document.querySelector("#drop-zone")!;

  const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
  const modalClose = document.querySelector<HTMLButtonElement>("#modal-close")!;
  const modalCancel = document.querySelector<HTMLButtonElement>("#modal-cancel")!;
  const modalConnect = document.querySelector<HTMLButtonElement>("#modal-connect")!;
  const togglePortBtn = document.querySelector<HTMLButtonElement>("#toggle-port")!;
  const hostInput = document.querySelector<HTMLInputElement>("#host")!;
  const portInput = document.querySelector<HTMLInputElement>("#port")!;
  const usernameInput = document.querySelector<HTMLInputElement>("#username")!;
  const passwordInput = document.querySelector<HTMLInputElement>("#password")!;

  // Local panel controls
  const localBackBtn = document.querySelector<HTMLButtonElement>("#local-back-btn")!;
  const localGoBtn = document.querySelector<HTMLButtonElement>("#local-go-btn")!;
  const localNewFolderBtn = document.querySelector<HTMLButtonElement>("#local-new-folder-btn")!;
  const localRefreshBtn = document.querySelector<HTMLButtonElement>("#local-refresh-btn")!;

  // Remote panel controls
  const remoteBackBtn = document.querySelector<HTMLButtonElement>("#remote-back-btn")!;
  const remoteGoBtn = document.querySelector<HTMLButtonElement>("#remote-go-btn")!;
  const remoteNewFolderBtn = document.querySelector<HTMLButtonElement>("#remote-new-folder-btn")!;
  const remoteRefreshBtn = document.querySelector<HTMLButtonElement>("#remote-refresh-btn")!;

  // Queue controls
  const queueClearBtn = document.querySelector<HTMLButtonElement>("#queue-clear-btn")!;

  // Zoom controls
  const zoomInBtn = document.querySelector<HTMLButtonElement>("#zoom-in")!;
  const zoomOutBtn = document.querySelector<HTMLButtonElement>("#zoom-out")!;
  const zoomLevelSpan = document.querySelector<HTMLSpanElement>("#zoom-level")!;

  // Search controls
  const localSearchInput = document.querySelector<HTMLInputElement>("#local-search")!;
const remoteSearchInput = document.querySelector<HTMLInputElement>("#remote-search")!;

localSearchInput.addEventListener("input", () => {
  filterFileList(localFileList, localSearchInput.value);
});

remoteSearchInput.addEventListener("input", () => {
  filterFileList(remoteFileList, remoteSearchInput.value);
});

function filterFileList(container: HTMLElement, query: string) {
  const items = container.querySelectorAll(".file-item");
  const lowerQuery = query.toLowerCase();
  
  items.forEach((item) => {
    const name = item.getAttribute("data-name")?.toLowerCase() || "";
    if (name.includes(lowerQuery)) {
      (item as HTMLElement).style.display = "";
    } else {
      (item as HTMLElement).style.display = "none";
    }
  });
}

  // Initialize
  setupProgressListener();
  setupTauriDragDrop();
  setupDropZoneVisuals();

  // Load local home directory
  try {
    localPath = await invoke<string>("get_home_dir");
    localPathInput.value = localPath;
    await loadLocalDirectory(localPath);
  } catch (error) {
    console.error("Failed to get home directory:", error);
    localPath = "/";
    localPathInput.value = localPath;
  }

  // Zoom controls
  function updateZoom(delta: number) {
    currentZoom = Math.max(0.75, Math.min(1.5, currentZoom + delta));
    document.documentElement.style.setProperty("--zoom", currentZoom.toString());
    zoomLevelSpan.textContent = Math.round(currentZoom * 100) + "%";
  }

  zoomInBtn.addEventListener("click", () => updateZoom(0.1));
  zoomOutBtn.addEventListener("click", () => updateZoom(-0.1));

  // Connection modal
  connectBtn.addEventListener("click", () => {
    if (isConnected) {
      disconnectFromServer();
    } else {
      connectionModal.classList.remove("hidden");
      hostInput.focus();
    }
  });

  modalClose.addEventListener("click", () => connectionModal.classList.add("hidden"));
  modalCancel.addEventListener("click", () => connectionModal.classList.add("hidden"));

  // Port toggle
  togglePortBtn.addEventListener("click", () => {
    if (portInput.type === "password") {
      portInput.type = "text";
      togglePortBtn.textContent = "🙈";
    } else {
      portInput.type = "password";
      togglePortBtn.textContent = "👁️";
    }
  });

  // Enter key to connect
  [hostInput, portInput, usernameInput, passwordInput].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        modalConnect.click();
      }
    });
  });

  // Connect
  modalConnect.addEventListener("click", async () => {
    const host = hostInput.value;
    const port = parseInt(portInput.value) || 22;
    const username = usernameInput.value;
    const password = passwordInput.value;

    if (!host || !username || !password) {
      connectStatus.textContent = "Please fill in all fields";
      connectStatus.className = "error";
      return;
    }

    connectStatus.textContent = "Connecting...";
    connectStatus.className = "";
    modalConnect.disabled = true;

    try {
      await invoke("connect", { host, port, username, password });
      isConnected = true;
      connectedHost = host;
      connectionModal.classList.add("hidden");
      updateConnectionUI();
      await loadRemoteDirectory("/");
    } catch (error) {
      connectStatus.textContent = `${error}`;
      connectStatus.className = "error";
    } finally {
      modalConnect.disabled = false;
    }
  });

  // Local navigation
  localBackBtn.addEventListener("click", () => navigateLocalUp());
  localGoBtn.addEventListener("click", () => loadLocalDirectory(localPathInput.value));
  localPathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadLocalDirectory(localPathInput.value);
  });
  localNewFolderBtn.addEventListener("click", () => createLocalFolder());
  localRefreshBtn.addEventListener("click", () => loadLocalDirectory(localPath));

  // Remote navigation
  remoteBackBtn.addEventListener("click", () => navigateRemoteUp());
  remoteGoBtn.addEventListener("click", () => loadRemoteDirectory(remotePathInput.value));
  remotePathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadRemoteDirectory(remotePathInput.value);
  });
  remoteNewFolderBtn.addEventListener("click", () => createRemoteFolder());
  remoteRefreshBtn.addEventListener("click", () => loadRemoteDirectory(remotePath));

  // Upload selected
  uploadSelectedBtn.addEventListener("click", () => uploadSelectedFiles());

  // Queue clear
  queueClearBtn.addEventListener("click", () => {
    uploadQueue = uploadQueue.filter(
      (f) => f.status === "pending" || f.status === "uploading"
    );
    renderQueue();
  });
});

// ============ CONNECTION ============

function updateConnectionUI() {
  const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
  const statusDot = connectionStatusDiv.querySelector(".status-dot")!;
  const statusText = connectionStatusDiv.querySelector(".status-text")!;

  if (isConnected) {
    statusDot.className = "status-dot connected";
    statusText.textContent = `Connected to ${connectedHost}`;
    connectBtn.textContent = "Disconnect";
    connectBtn.classList.remove("primary");
    remoteServerName.textContent = connectedHost;
  } else {
    statusDot.className = "status-dot disconnected";
    statusText.textContent = "Not Connected";
    connectBtn.textContent = "🔗 Connect";
    connectBtn.classList.add("primary");
    remoteServerName.textContent = "";
    remoteFileList.innerHTML = `
      <div class="not-connected-message">
        <p>🔌 Not connected</p>
        <p class="hint">Click "Connect" to access remote files</p>
      </div>
    `;
  }
}

async function disconnectFromServer() {
  try {
    await invoke("disconnect");
  } catch (error) {
    console.error("Disconnect error:", error);
  }
  isConnected = false;
  connectedHost = "";
  updateConnectionUI();
}

// ============ LOCAL FILE SYSTEM ============

async function loadLocalDirectory(path: string) {
  try {
    localFileList.innerHTML = "<div class='loading'>⏳ Loading...</div>";
    selectedLocalFiles.clear();
    updateUploadButton();

    const files = await invoke<FileEntry[]>("list_local_dir", { path });

    localPath = path;
    localPathInput.value = path;

    files.sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name);
    });

    if (files.length === 0) {
      localFileList.innerHTML = "<div class='empty'>📂 Empty directory</div>";
      return;
    }

    renderFileList(localFileList, files, "local");
  } catch (error) {
    localFileList.innerHTML = `<div class="error">❌ Error: ${error}</div>`;
  }
}

function navigateLocalUp() {
  // Handle Windows paths (C:\Users\...)
  if (localPath.match(/^[A-Z]:\\/i)) {
    const parts = localPath.split("\\").filter(Boolean);
    parts.pop();
    
    if (parts.length === 0) {
      // Already at root like C:\
      return;
    }
    
    // First part is "C:" - reconstruct properly
    const parentPath = parts[0] + "\\" + parts.slice(1).join("\\");
    loadLocalDirectory(parentPath || parts[0] + "\\");
  } else {
    // Unix paths
    const parts = localPath.split("/").filter(Boolean);
    parts.pop();
    loadLocalDirectory("/" + parts.join("/") || "/");
  }
}

async function createLocalFolder() {
  const folderName = prompt("Enter folder name:");
  if (folderName && folderName.trim()) {
    const separator = localPath.includes("\\") ? "\\" : "/";
    const newPath = localPath + separator + folderName.trim();

    try {
      await invoke("create_local_directory", { path: newPath });
      await loadLocalDirectory(localPath);
    } catch (error) {
      alert(`❌ Failed to create folder: ${error}`);
    }
  }
}

// ============ REMOTE FILE SYSTEM ============

async function loadRemoteDirectory(path: string) {
  if (!isConnected) return;

  try {
    remoteFileList.innerHTML = "<div class='loading'>⏳ Loading...</div>";

    const files = await invoke<FileEntry[]>("list_remote_dir", { path });

    remotePath = path;
    remotePathInput.value = path;

    files.sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name);
    });

    if (files.length === 0) {
      remoteFileList.innerHTML = "<div class='empty'>📂 Empty directory</div>";
      return;
    }

    renderFileList(remoteFileList, files, "remote");
  } catch (error) {
    remoteFileList.innerHTML = `<div class="error">❌ Error: ${error}</div>`;
  }
}

function navigateRemoteUp() {
  const parts = remotePath.split("/").filter(Boolean);
  parts.pop();
  const parentPath = "/" + parts.join("/");
  loadRemoteDirectory(parentPath || "/");
}

async function createRemoteFolder() {
  if (!isConnected) {
    alert("⚠️ Please connect to a server first");
    return;
  }

  const folderName = prompt("Enter folder name:");
  if (folderName && folderName.trim()) {
    const newPath = remotePath === "/" 
      ? `/${folderName.trim()}` 
      : `${remotePath}/${folderName.trim()}`;

    try {
      await invoke("create_remote_directory", { remotePath: newPath });
      await loadRemoteDirectory(remotePath);
    } catch (error) {
      alert(`❌ Failed to create folder: ${error}`);
    }
  }
}

// ============ FILE LIST RENDERING ============

function renderFileList(container: HTMLElement, files: FileEntry[], type: "local" | "remote") {
  container.innerHTML = files
    .map((file) => {
      const icon = file.is_dir ? "📁" : "📄";
      const sizeText = file.is_dir ? "" : formatSize(file.size);
      const fullPath = type === "local"
        ? (localPath + (localPath.endsWith("/") || localPath.endsWith("\\") ? "" : (localPath.includes("\\") ? "\\" : "/")) + file.name)
        : (remotePath === "/" ? `/${file.name}` : `${remotePath}/${file.name}`);

      return `
        <div class="file-item" 
             data-name="${file.name}" 
             data-path="${fullPath}"
             data-is-dir="${file.is_dir}" 
             data-type="${type}">
          <span class="file-icon">${icon}</span>
          <span class="file-name">${file.name}</span>
          <span class="file-size">${sizeText}</span>
          <div class="file-actions">
            <button class="delete-btn small danger">Delete</button>
          </div>
        </div>
      `;
    })
    .join("");

  // Add event listeners
  container.querySelectorAll(".file-item").forEach((item) => {
    const name = item.getAttribute("data-name")!;
    const path = item.getAttribute("data-path")!;
    const isDir = item.getAttribute("data-is-dir") === "true";
    const itemType = item.getAttribute("data-type") as "local" | "remote";

    // Double-click to navigate into directory
    item.addEventListener("dblclick", () => {
      if (isDir) {
        if (itemType === "local") {
          loadLocalDirectory(path);
        } else {
          loadRemoteDirectory(path);
        }
      }
    });

    // Single click to select (local only)
    if (itemType === "local" && !isDir) {
      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("delete-btn")) return;

        if (selectedLocalFiles.has(path)) {
          selectedLocalFiles.delete(path);
          item.classList.remove("selected");
        } else {
          selectedLocalFiles.add(path);
          item.classList.add("selected");
        }
        updateUploadButton();
      });
    }

    // Delete button
    const deleteBtn = item.querySelector(".delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const typeText = isDir ? "directory" : "file";
        const confirmed = confirm(`Are you sure you want to delete "${name}"?${isDir ? "\n\nNote: Directory must be empty to delete." : ""}`);

        if (confirmed) {
          try {
            if (itemType === "local") {
              await invoke("delete_local_file", { path });
              await loadLocalDirectory(localPath);
            } else {
              await invoke("delete_remote_file", { remotePath: path });
              await loadRemoteDirectory(remotePath);
            }
          } catch (error) {
            alert(`❌ Delete failed: ${error}`);
          }
        }
      });
    }
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

// ============ UPLOAD ============

function updateUploadButton() {
  const count = selectedLocalFiles.size;
  uploadSelectedBtn.disabled = count === 0 || !isConnected;
  uploadSelectedBtn.textContent = count > 0 
    ? `📤 Upload Selected (${count})` 
    : "📤 Upload Selected";
}

async function uploadSelectedFiles() {
  if (!isConnected) {
    alert("⚠️ Please connect to a server first");
    return;
  }

  const files = Array.from(selectedLocalFiles);
  await queueFilesForUpload(files);

  // Clear selection
  selectedLocalFiles.clear();
  document.querySelectorAll("#local-file-list .file-item.selected").forEach((item) => {
    item.classList.remove("selected");
  });
  updateUploadButton();
}

async function queueFilesForUpload(filePaths: string[]) {
  if (!isConnected) {
    alert("⚠️ Please connect to a server first");
    return;
  }

  for (const filePath of filePaths) {
    const fileName = filePath.split(/[/\\]/).pop() || "unknown";
    const remoteFilePath = remotePath === "/" 
      ? `/${fileName}` 
      : `${remotePath}/${fileName}`;

    // Check if file exists
    try {
      const exists = await invoke<boolean>("remote_file_exists", { remotePath: remoteFilePath });
      if (exists) {
        const overwrite = confirm(`"${fileName}" already exists on the remote server. Overwrite?`);
        if (!overwrite) continue;
      }
    } catch (error) {
      console.error("Failed to check if file exists:", error);
    }

    const queuedFile: QueuedFile = {
      id: crypto.randomUUID(),
      localPath: filePath,
      fileName,
      remotePath: remoteFilePath,
      status: "pending",
      progress: 0,
    };

    uploadQueue.push(queuedFile);
  }

  renderQueue();
  processQueue();
}

// ============ QUEUE ============

function renderQueue() {
  const complete = uploadQueue.filter((f) => f.status === "complete").length;
  const errors = uploadQueue.filter((f) => f.status === "error").length;
  const total = uploadQueue.length;

  queueStatusSpan.textContent = total > 0
    ? `${complete}/${total}${errors > 0 ? ` (${errors} failed)` : ""}`
    : "";

  if (uploadQueue.length === 0) {
    queueListDiv.innerHTML = '<div class="queue-empty">📭 No uploads in queue</div>';
    return;
  }

  queueListDiv.innerHTML = uploadQueue
    .map((file) => {
      let statusIcon = "";
      let statusText = "";
      let statusClass = "";

      switch (file.status) {
        case "pending":
          statusIcon = "⏳";
          statusText = "Pending";
          statusClass = "pending";
          break;
        case "uploading":
          statusIcon = "📤";
          statusText = "Uploading";
          statusClass = "uploading";
          break;
        case "complete":
          statusIcon = "✅";
          statusText = "Complete";
          statusClass = "complete";
          break;
        case "error":
          statusIcon = "❌";
          statusText = "Failed";
          statusClass = "error";
          break;
      }

      return `
        <div class="queue-item ${statusClass}">
          <div class="queue-item-header">
            <span class="queue-item-name" title="${file.fileName}">${statusIcon} ${file.fileName}</span>
            <span class="queue-item-status">${statusText}</span>
          </div>
          ${file.error ? `<div class="queue-item-error">⚠️ ${file.error}</div>` : ""}
          <div class="queue-item-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${file.progress}%"></div>
            </div>
            <span class="progress-text">${file.progress}%</span>
          </div>
          ${file.status === "pending" ? `<button class="queue-remove-btn small" data-id="${file.id}">Remove</button>` : ""}
        </div>
      `;
    })
    .join("");

  queueListDiv.querySelectorAll(".queue-remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).getAttribute("data-id")!;
      uploadQueue = uploadQueue.filter((f) => f.id !== id);
      renderQueue();
    });
  });
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (true) {
    const pendingFiles = uploadQueue.filter((f) => f.status === "pending");

    if (pendingFiles.length === 0 || activeUploads >= MAX_CONCURRENT_UPLOADS) {
      break;
    }

    const file = pendingFiles[0];
    file.status = "uploading";
    activeUploads++;
    renderQueue();

    uploadSingleFile(file).finally(() => {
      activeUploads--;
      processQueue();
    });
  }

  isProcessingQueue = false;

  // Refresh remote directory when all complete
  const allComplete = uploadQueue.every(
    (f) => f.status === "complete" || f.status === "error"
  );
  if (allComplete && uploadQueue.length > 0 && isConnected) {
    await loadRemoteDirectory(remotePath);
  }
}

async function uploadSingleFile(file: QueuedFile) {
  try {
    await invoke<string>("upload_file", {
      localPath: file.localPath,
      remotePath: file.remotePath,
    });
    file.status = "complete";
    file.progress = 100;
  } catch (error) {
    file.status = "error";
    file.error = String(error);
  }
  renderQueue();
}

function setupProgressListener() {
  listen<UploadProgress>("upload-progress", (event) => {
    const progress = event.payload;
    const file = uploadQueue.find(
      (f) => f.fileName === progress.file_name && f.status === "uploading"
    );
    if (file) {
      file.progress = progress.percent;
      renderQueue();
    }
  });
}

// ============ DRAG AND DROP ============

function setupTauriDragDrop() {
  listen<DragDropEvent>("tauri://drag-drop", async (event) => {
    const paths = event.payload.paths;
    if (paths && paths.length > 0) {
      if (!isConnected) {
        alert("⚠️ Please connect to a server first");
        return;
      }
      await queueFilesForUpload(paths);
    }
  });

  listen("tauri://drag-enter", () => {
    dropZone.classList.add("drag-over");
  });

  listen("tauri://drag-leave", () => {
    dropZone.classList.remove("drag-over");
  });
}

function setupDropZoneVisuals() {
  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("drag-over");
    });
  });
}