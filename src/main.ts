import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

interface UploadProgress {
  file_name: string;
  local_path: string;
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
  isDirectory?: boolean;
}

interface LocalFileInfo {
  absolute_path: string;
  relative_path: string;
  is_dir: boolean;
}

interface DragDropEvent {
  paths: string[];
  position: { x: number; y: number };
}
interface ConnectionProfile {
  name: string;
  host: string;
  port: number;
  username: string;
}

// ============ UPLOAD QUEUE MANAGER ============

class UploadQueueManager {
  private queue: QueuedFile[] = [];
  private activeUploads: Map<string, Promise<void>> = new Map();
  private processingPromise: Promise<void> | null = null;
  private maxConcurrent: number;
  private renderCallback: () => void;
  private onAllCompleteCallback: () => void;

  constructor(maxConcurrent: number = 2, renderCallback: () => void, onAllCompleteCallback: () => void) {
    this.maxConcurrent = maxConcurrent;
    this.renderCallback = renderCallback;
    this.onAllCompleteCallback = onAllCompleteCallback;
  }

  getQueue(): QueuedFile[] {
    return this.queue;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getCompleteCount(): number {
    return this.queue.filter(f => f.status === "complete").length;
  }

  getErrorCount(): number {
    return this.queue.filter(f => f.status === "error").length;
  }

  addFile(file: QueuedFile): void {
    this.queue.push(file);
  }

  removeFile(id: string): void {
    this.queue = this.queue.filter(f => f.id !== id);
    this.renderCallback();
  }

  clearCompleted(): void {
    this.queue = this.queue.filter(f => f.status === "pending" || f.status === "uploading");
    this.renderCallback();
  }

  updateProgress(localPath: string, percent: number): void {
    const file = this.queue.find(f => f.localPath === localPath && f.status === "uploading");
    if (file) {
      file.progress = percent;
    }
  }

  findByLocalPath(localPath: string): QueuedFile | undefined {
    return this.queue.find(f => f.localPath === localPath && f.status === "uploading");
  }

  async processQueue(): Promise<void> {
    // If already processing, wait for existing processing to complete then continue
    if (this.processingPromise) {
      await this.processingPromise;
    }

    this.processingPromise = this.doProcessQueue();
    await this.processingPromise;
    this.processingPromise = null;
  }

  private async doProcessQueue(): Promise<void> {
    while (true) {
      const pendingFiles = this.queue.filter(f => f.status === "pending");

      if (pendingFiles.length === 0 || this.activeUploads.size >= this.maxConcurrent) {
        break;
      }

      const file = pendingFiles[0];
      file.status = "uploading";
      this.renderCallback();

      const uploadPromise = this.uploadSingleFile(file).finally(() => {
        this.activeUploads.delete(file.id);
        // Continue processing queue after upload completes
        this.processQueue();
      });

      this.activeUploads.set(file.id, uploadPromise);
    }

    // Check if all complete
    const allComplete = this.queue.length > 0 &&
      this.queue.every(f => f.status === "complete" || f.status === "error");

    if (allComplete && this.activeUploads.size === 0) {
      this.onAllCompleteCallback();
    }
  }

  private async uploadSingleFile(file: QueuedFile): Promise<void> {
    try {
      if (file.isDirectory) {
        await invoke<string>("create_remote_directory", {
          remotePath: file.remotePath,
        });
        file.status = "complete";
        file.progress = 100;
      } else {
        await invoke<string>("upload_file", {
          localPath: file.localPath,
          remotePath: file.remotePath,
        });
        file.status = "complete";
        file.progress = 100;
      }
    } catch (error) {
      file.status = "error";
      file.error = String(error);
    }
    this.renderCallback();
  }
}

// State
let localPath = "";
let remotePath = "/";
let isConnected = false;
let connectedHost = "";
let currentZoom = 1;
let lastSelectedIndex: number = -1;
let selectedSavedProfile: string | null = null;
let currentTheme: "tokyo-night" | "blackout" = "blackout";

// Custom drag state
let isMouseDragging = false;
let dragStartPos = { x: 0, y: 0 };
const dragThreshold = 5;
let dragGhost: HTMLElement | null = null;
let draggedItems: string[] = [];

// Selection
let selectedLocalFiles: Set<string> = new Set();

// Upload queue manager (initialized in DOMContentLoaded)
let queueManager: UploadQueueManager;

// Render throttling
let renderQueued = false;
let lastRenderTime = 0;
const RENDER_THROTTLE_MS = 100;

// ============ THEME MANAGEMENT ============

function initializeTheme() {
  const savedTheme = localStorage.getItem("deaddrop-theme") as "tokyo-night" | "blackout" | null;
  currentTheme = savedTheme || "blackout";
  applyTheme(currentTheme);
}

function applyTheme(theme: "tokyo-night" | "blackout") {
  document.documentElement.setAttribute("data-theme", theme);
  currentTheme = theme;
  localStorage.setItem("deaddrop-theme", theme);
  updateThemeButtons();
}

function updateThemeButtons() {
  const tokyoBtn = document.getElementById("theme-tokyo");
  const blackoutBtn = document.getElementById("theme-blackout");

  if (tokyoBtn && blackoutBtn) {
    tokyoBtn.classList.toggle("active", currentTheme === "tokyo-night");
    blackoutBtn.classList.toggle("active", currentTheme === "blackout");
  }
}

function setupThemeToggle() {
  const tokyoBtn = document.getElementById("theme-tokyo");
  const blackoutBtn = document.getElementById("theme-blackout");

  if (tokyoBtn) {
    tokyoBtn.addEventListener("click", () => applyTheme("tokyo-night"));
  }

  if (blackoutBtn) {
    blackoutBtn.addEventListener("click", () => applyTheme("blackout"));
  }
}

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
let rememberCheckbox: HTMLInputElement;
let rememberLabel: HTMLLabelElement;


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

  // Initialize queue manager
  queueManager = new UploadQueueManager(
    2, // max concurrent uploads
    () => renderQueue(), // render callback
    async () => {
      // on all complete callback - refresh remote directory
      if (isConnected) {
        await loadRemoteDirectory(remotePath);
      }
    }
  );

  const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
  const modalClose = document.querySelector<HTMLButtonElement>("#modal-close")!;
  const modalCancel = document.querySelector<HTMLButtonElement>("#modal-cancel")!;
  const modalConnect = document.querySelector<HTMLButtonElement>("#modal-connect")!;
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

  // Profile related buttons
  const saveProfileBtn = document.querySelector<HTMLButtonElement>("#save-profile-btn")!;
  const profileNameInput = document.querySelector<HTMLInputElement>("#profile-name")!;
  rememberCheckbox = document.querySelector<HTMLInputElement>("#remember-password")!;
  rememberLabel = document.querySelector<HTMLLabelElement>("label[for='remember-password']")!;

  localSearchInput.addEventListener("input", () => {
    filterFileList(localFileList, localSearchInput.value);
  });

  remoteSearchInput.addEventListener("input", () => {
    filterFileList(remoteFileList, remoteSearchInput.value);
  });

  // Initialize
  initializeTheme();
  setupThemeToggle();
  setupProgressListener();
  setupTauriDragDrop();
  setupCustomDrag();

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

  // Ctrl+Scroll to zoom
  document.addEventListener("wheel", (e: WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      updateZoom(delta);
    }
  }, { passive: false });

  // Connection modal - open
  connectBtn.addEventListener("click", () => {
    if (isConnected) {
      disconnectFromServer();
    } else {
      connectionModal.classList.remove("hidden");
      connectStatus.textContent = "";  // Clear any previous error
      connectStatus.className = "";    // Reset class
      renderProfiles();
      hostInput.focus();
    }
});

  // Close modal handlers - clear state
  modalClose.addEventListener("click", () => {
    connectionModal.classList.add("hidden");
    connectStatus.textContent = "";
  });

  modalCancel.addEventListener("click", () => {
    connectionModal.classList.add("hidden");
    connectStatus.textContent = "";
  });

  // Enter key to connect
  [hostInput, portInput, usernameInput, passwordInput].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        modalConnect.click();
      }
    });
  });

// Connect button
modalConnect.addEventListener("click", async () => {
  const host = hostInput.value.trim();
  const port = parseInt(portInput.value) || 22;
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  // ... validation code ...

  connectStatus.textContent = "Connecting...";
  connectStatus.className = "";
  modalConnect.disabled = true;

  try {
    // Get the checkbox and profile name values
    const profileName = selectedSavedProfile;  // Will be null if no profile selected
    const rememberPwd = rememberCheckbox.checked;

    await invoke("connect", { 
      host, 
      port, 
      username, 
      password,
      profileName: profileName,
      rememberPassword: rememberPwd 
    });
    
    isConnected = true;
    connectedHost = host;
    connectionModal.classList.add("hidden");
    
    passwordInput.value = "";
    connectStatus.textContent = "";
    
    updateConnectionUI();
    updateUploadButton();
    await loadRemoteDirectory("/");
  } catch (error) {
    connectStatus.textContent = `${error}`;
    connectStatus.className = "error";
  } finally {
    modalConnect.disabled = false;
  }
});


  // Save profile
  saveProfileBtn.addEventListener("click", async () => {
    const name = profileNameInput.value.trim();
    const host = hostInput.value.trim();
    const port = parseInt(portInput.value) || 22;
    const username = usernameInput.value.trim();

    if (!name) {
      alert("Please enter a profile name");
      profileNameInput.focus();
      return;
    }

    if (!host || !username) {
      alert("Please fill in host and username first");
      return;
    }

    try {
      await invoke("save_profile", { name, host, port, username });
      profileNameInput.value = "";
      await renderProfiles();
      showToast(`Profile "${name}" saved`, "success");
    } catch (error) {
      showToast(`${error}`, "error");
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
    queueManager.clearCompleted();
  });
});


// ============ HELPERS ============

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


function showConfirm(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal")!;
    const titleEl = document.getElementById("confirm-title")!;
    const messageEl = document.getElementById("confirm-message")!;
    const okBtn = document.getElementById("confirm-ok")!;
    const cancelBtn = document.getElementById("confirm-cancel")!;

    titleEl.textContent = title;
    messageEl.textContent = message;
    modal.classList.remove("hidden");

    const cleanup = () => {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
    };

    const onOk = () => {
      cleanup();
      resolve(true);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}


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
  updateUploadButton();
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
  if (localPath.match(/^[A-Z]:\\/i)) {
    const parts = localPath.split("\\").filter(Boolean);
    parts.pop();

    if (parts.length === 0) {
      return;
    }

    const parentPath = parts[0] + "\\" + parts.slice(1).join("\\");
    loadLocalDirectory(parentPath || parts[0] + "\\");
  } else {
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
    const newPath =
      remotePath === "/"
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

function renderFileList(
  container: HTMLElement,
  files: FileEntry[],
  type: "local" | "remote"
) {
  container.innerHTML = files
    .map((file) => {
      const icon = file.is_dir ? "📁" : "📄";
      const sizeText = file.is_dir ? "" : formatSize(file.size);
      const fullPath =
        type === "local"
          ? localPath +
            (localPath.endsWith("/") || localPath.endsWith("\\")
              ? ""
              : localPath.includes("\\")
              ? "\\"
              : "/") +
            file.name
          : remotePath === "/"
          ? `/${file.name}`
          : `${remotePath}/${file.name}`;

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
            ${type === "remote" && !file.is_dir ? `<button class="download-btn small" title="Download"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>` : ""}
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

    // Single click to select (local items only)
    if (itemType === "local") {
      item.addEventListener("click", (e: Event) => {
      const target = e.target as HTMLElement;
          
          // Exit early if clicking delete button or any of its children
          if (target.closest(".delete-btn")) {
            console.log("Selection handler: Ignoring delete button click");
            return;
          }
          if (target.closest(".file-actions")) {
            console.log("Selection handler: Ignoring file-actions click");
            return;
          }

        const mouseEvent = e as MouseEvent;
        if ((e.target as HTMLElement).closest(".delete-btn")) return;

        const allItems = Array.from(container.querySelectorAll(".file-item"));
        const currentIndex = allItems.indexOf(item);

        if (mouseEvent.shiftKey && lastSelectedIndex !== -1) {
          const start = Math.min(lastSelectedIndex, currentIndex);
          const end = Math.max(lastSelectedIndex, currentIndex);

          for (let i = start; i <= end; i++) {
            const rangeItem = allItems[i] as HTMLElement;
            const rangePath = rangeItem.getAttribute("data-path")!;
            selectedLocalFiles.add(rangePath);
            rangeItem.classList.add("selected");
          }
        } else if (mouseEvent.ctrlKey || mouseEvent.metaKey) {
          if (selectedLocalFiles.has(path)) {
            selectedLocalFiles.delete(path);
            item.classList.remove("selected");
          } else {
            selectedLocalFiles.add(path);
            item.classList.add("selected");
          }
          lastSelectedIndex = currentIndex;
        } else {
          selectedLocalFiles.clear();
          container.querySelectorAll(".file-item.selected").forEach((el) => {
            el.classList.remove("selected");
          });
          selectedLocalFiles.add(path);
          item.classList.add("selected");
          lastSelectedIndex = currentIndex;
        }
        updateUploadButton();
      });
    }

    // Delete button (for both local and remote)
    const deleteBtn = item.querySelector(".delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        const message = isDir
          ? `Are you sure you want to delete "${name}" and all its contents? This action cannot be undone.`
          : `Are you sure you want to delete "${name}"?`;
        
        const confirmed = await showConfirm("Confirm Delete", message);
        
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
            showToast(`Delete failed: ${error}`, "error");
          }
        }
      });
    }

    // Download button (for remote files only)
    const downloadBtn = item.querySelector(".download-btn");
    if (downloadBtn) {
      downloadBtn.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        try {
          // Open save dialog with suggested filename
          const savePath = await save({
            defaultPath: name,
            title: "Save file as",
          });

          if (savePath) {
            showToast(`Downloading ${name}...`, "success");
            await invoke("download_file", {
              remotePath: path,
              localPath: savePath,
            });
            showToast(`Downloaded ${name}`, "success");
          }
        } catch (error) {
          showToast(`Download failed: ${error}`, "error");
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
  uploadSelectedBtn.textContent =
    count > 0 ? `📤 Upload Selected (${count})` : "📤 Upload Selected";
}

async function uploadSelectedFiles() {
  if (!isConnected) {
    alert("⚠️ Please connect to a server first");
    return;
  }

  const files = Array.from(selectedLocalFiles);
  await queueFilesForUpload(files);

  selectedLocalFiles.clear();
  document
    .querySelectorAll("#local-file-list .file-item.selected")
    .forEach((item) => {
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
    const isDir = await invoke<boolean>("is_directory", { path: filePath });

    if (isDir) {
      try {
        const allFiles = await invoke<LocalFileInfo[]>(
          "list_local_dir_recursive",
          { path: filePath }
        );

        allFiles.sort((a, b) => {
          if (a.is_dir && !b.is_dir) return -1;
          if (!a.is_dir && b.is_dir) return 1;
          return a.relative_path.localeCompare(b.relative_path);
        });

        for (const file of allFiles) {
          const relativePath = file.relative_path.replace(/\\/g, "/");
          const remoteFilePath =
            remotePath === "/"
              ? `/${relativePath}`
              : `${remotePath}/${relativePath}`;

          if (file.is_dir) {
            const queuedDir: QueuedFile = {
              id: crypto.randomUUID(),
              localPath: file.absolute_path,
              fileName: `📁 ${relativePath}`,
              remotePath: remoteFilePath,
              status: "pending",
              progress: 0,
              isDirectory: true,
            };
            queueManager.addFile(queuedDir);
          } else {
            try {
              const exists = await invoke<boolean>("remote_file_exists", {
                remotePath: remoteFilePath,
              });
              if (exists) {
                const overwrite = confirm(
                  `"${relativePath}" already exists on the remote server. Overwrite?`
                );
                if (!overwrite) continue;
              }
            } catch (error) {
              console.error("Failed to check if file exists:", error);
            }

            const queuedFile: QueuedFile = {
              id: crypto.randomUUID(),
              localPath: file.absolute_path,
              fileName: relativePath,
              remotePath: remoteFilePath,
              status: "pending",
              progress: 0,
              isDirectory: false,
            };
            queueManager.addFile(queuedFile);
          }
        }
      } catch (error) {
        console.error("Failed to list directory:", error);
        alert(`❌ Failed to read directory: ${error}`);
      }
    } else {
      const fileName = filePath.split(/[/\\]/).pop() || "unknown";
      const remoteFilePath =
        remotePath === "/" ? `/${fileName}` : `${remotePath}/${fileName}`;

      try {
        const exists = await invoke<boolean>("remote_file_exists", {
          remotePath: remoteFilePath,
        });
        if (exists) {
          const overwrite = confirm(
            `"${fileName}" already exists on the remote server. Overwrite?`
          );
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
        isDirectory: false,
      };
      queueManager.addFile(queuedFile);
    }
  }

  renderQueue();
  queueManager.processQueue();
}

// ============ QUEUE ============

function renderQueue() {
  const queue = queueManager.getQueue();
  const complete = queueManager.getCompleteCount();
  const errors = queueManager.getErrorCount();
  const total = queueManager.getQueueLength();

  queueStatusSpan.textContent =
    total > 0
      ? `${complete}/${total}${errors > 0 ? ` (${errors} failed)` : ""}`
      : "";

  if (total === 0) {
    queueListDiv.innerHTML =
      '<div class="queue-empty">📭 No uploads in queue</div>';
    return;
  }

  queueListDiv.innerHTML = queue
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
        <div class="queue-item ${statusClass}" data-id="${file.id}">
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
      queueManager.removeFile(id);
    });
  });
}

function setupProgressListener() {
  listen<UploadProgress>("upload-progress", (event) => {
    const progress = event.payload;
    const file = queueManager.findByLocalPath(progress.local_path);
    if (file) {
      queueManager.updateProgress(progress.local_path, progress.percent);

      // Update just the progress bar, not the entire queue
      const queueItem = queueListDiv.querySelector(`[data-id="${file.id}"]`);
      if (queueItem) {
        const progressFill = queueItem.querySelector(".progress-fill") as HTMLElement;
        const progressText = queueItem.querySelector(".progress-text");
        if (progressFill) progressFill.style.width = `${progress.percent}%`;
        if (progressText) progressText.textContent = `${progress.percent}%`;
      } else {
        // Element not found, do a full render (throttled)
        throttledRenderQueue();
      }
    }
  });
}

// ============ TAURI DRAG AND DROP (External files from Windows) ============

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

// ============ CUSTOM MOUSE DRAG SYSTEM (Internal drag within app) ============

function setupCustomDrag() {
  let mouseDownTarget: HTMLElement | null = null;
  let mouseDownPath: string | null = null;
  let hasDragStarted = false;

  localFileList.addEventListener("mousedown", (e: MouseEvent) => {
    const fileItem = (e.target as HTMLElement).closest(
      ".file-item"
    ) as HTMLElement;
    if (!fileItem) return;
    if ((e.target as HTMLElement).closest(".delete-btn")) return;
    if (fileItem.dataset.type !== "local") return;

    mouseDownTarget = fileItem;
    mouseDownPath = fileItem.dataset.path || null;
    dragStartPos = { x: e.clientX, y: e.clientY };
    hasDragStarted = false;
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!mouseDownTarget || !mouseDownPath) return;

    const dx = Math.abs(e.clientX - dragStartPos.x);
    const dy = Math.abs(e.clientY - dragStartPos.y);

    if (!hasDragStarted && (dx > dragThreshold || dy > dragThreshold)) {
      hasDragStarted = true;
      startCustomDrag(e, mouseDownPath);
    }

    if (hasDragStarted) {
      updateCustomDrag(e);
    }
  });

  document.addEventListener("mouseup", (e: MouseEvent) => {
    if (hasDragStarted) {
      endCustomDrag(e);
    }
    mouseDownTarget = null;
    mouseDownPath = null;
    hasDragStarted = false;
  });

  document.addEventListener("mouseleave", () => {
    if (hasDragStarted) {
      cancelCustomDrag();
    }
    mouseDownTarget = null;
    mouseDownPath = null;
    hasDragStarted = false;
  });
}

function startCustomDrag(e: MouseEvent, path: string) {
  if (selectedLocalFiles.has(path)) {
    draggedItems = Array.from(selectedLocalFiles);
  } else {
    draggedItems = [path];
  }

  isMouseDragging = true;

  dragGhost = document.createElement("div");
  dragGhost.className = "drag-ghost";

  const count = draggedItems.length;
  const fileName = draggedItems[0].split(/[/\\]/).pop() || "file";
  dragGhost.innerHTML = count > 1 ? `📦 ${count} items` : `📄 ${fileName}`;

  dragGhost.style.left = e.clientX + 10 + "px";
  dragGhost.style.top = e.clientY + 10 + "px";
  document.body.appendChild(dragGhost);

  if (isConnected) {
    dropZone.classList.add("custom-drag-active");
    remoteFileList.classList.add("custom-drag-active");
  }

  document.body.style.userSelect = "none";
}

function updateCustomDrag(e: MouseEvent) {
  if (!dragGhost) return;

  dragGhost.style.left = e.clientX + 10 + "px";
  dragGhost.style.top = e.clientY + 10 + "px";

  const elementsUnder = document.elementsFromPoint(e.clientX, e.clientY);

  const overDropZone = elementsUnder.some(
    (el) => el === dropZone || dropZone.contains(el)
  );
  const overRemoteList = elementsUnder.some(
    (el) => el === remoteFileList || remoteFileList.contains(el)
  );

  const overDropTarget = overDropZone || overRemoteList;

  dropZone.classList.toggle("custom-drag-hover", overDropZone && isConnected);
  remoteFileList.classList.toggle(
    "custom-drag-hover",
    overRemoteList && isConnected
  );

  // Show appropriate state on drag ghost
  if (overDropTarget && isConnected) {
    dragGhost.classList.add("can-drop");
    dragGhost.classList.remove("no-drop");
  } else if (overDropTarget && !isConnected) {
    dragGhost.classList.remove("can-drop");
    dragGhost.classList.add("no-drop");
  } else {
    dragGhost.classList.remove("can-drop");
    dragGhost.classList.remove("no-drop");
  }
}

async function endCustomDrag(e: MouseEvent) {
  if (!isMouseDragging || draggedItems.length === 0) {
    cancelCustomDrag();
    return;
  }

  const elementsUnder = document.elementsFromPoint(e.clientX, e.clientY);
  const overDropZone = elementsUnder.some(
    (el) => el === dropZone || dropZone.contains(el)
  );
  const overRemoteList = elementsUnder.some(
    (el) => el === remoteFileList || remoteFileList.contains(el)
  );

  const validDrop = (overDropZone || overRemoteList) && isConnected;

  cleanupCustomDrag();

  if (validDrop) {
    const items = [...draggedItems];
    draggedItems = [];

    await queueFilesForUpload(items);

    selectedLocalFiles.clear();
    document
      .querySelectorAll("#local-file-list .file-item.selected")
      .forEach((el) => {
        el.classList.remove("selected");
      });
    updateUploadButton();
  } else if (!isConnected && (overDropZone || overRemoteList)) {
    alert("⚠️ Please connect to a server first");
  }
}

function cancelCustomDrag() {
  cleanupCustomDrag();
  draggedItems = [];
}

function cleanupCustomDrag() {
  isMouseDragging = false;

  if (dragGhost) {
    dragGhost.remove();
    dragGhost = null;
  }

  dropZone.classList.remove("custom-drag-active", "custom-drag-hover");
  remoteFileList.classList.remove("custom-drag-active", "custom-drag-hover");
  document.body.style.userSelect = "";
}


function throttledRenderQueue() {
  const now = Date.now();
  
  if (now - lastRenderTime >= RENDER_THROTTLE_MS) {
    // Enough time passed, render immediately
    lastRenderTime = now;
    renderQueue();
  } else if (!renderQueued) {
    // Schedule a render
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      lastRenderTime = Date.now();
      renderQueue();
    }, RENDER_THROTTLE_MS - (now - lastRenderTime));
  }
}
// ============ PROFILES ============

async function loadProfiles(): Promise<ConnectionProfile[]> {
  try {
    return await invoke<ConnectionProfile[]>("get_profiles");
  } catch (error) {
    console.error("Failed to load profiles:", error);
    return [];
  }
}


async function renderProfiles() {
  const profilesList = document.querySelector("#profiles-list")!;
  const profilesCount = document.querySelector("#profiles-count")!;
  const profiles = await loadProfiles();

  profilesCount.textContent = `${profiles.length}/3`;

  if (profiles.length === 0) {
    profilesList.innerHTML = `
      <div class="profiles-empty">
        No saved profiles yet
      </div>
    `;
    return;
  }

  profilesList.innerHTML = profiles
    .map(
      (profile) => `
      <div class="profile-item" data-name="${profile.name}" data-host="${profile.host}" data-port="${profile.port}" data-username="${profile.username}">
        <div class="profile-item-info">
          <div class="profile-item-name">${profile.name}</div>
          <div class="profile-item-details">${profile.username}@${profile.host}:${profile.port}</div>
        </div>
        <button class="profile-item-delete small" data-name="${profile.name}">✕</button>
      </div>
    `
    )
    .join("");

  // Add click handlers
  profilesList.querySelectorAll(".profile-item").forEach((item) => {
    const el = item as HTMLElement;

    // Click to select profile and fill form
    item.addEventListener("click", async (e) => {  // ADD async
      if ((e.target as HTMLElement).classList.contains("profile-item-delete")) return;
      
      const hostInput = document.querySelector<HTMLInputElement>("#host")!;
      const portInput = document.querySelector<HTMLInputElement>("#port")!;
      const usernameInput = document.querySelector<HTMLInputElement>("#username")!;
      const passwordInput = document.querySelector<HTMLInputElement>("#password")!;
      const profileNameInput = document.querySelector<HTMLInputElement>("#profile-name")!;
      
      hostInput.value = el.dataset.host || "";
      portInput.value = el.dataset.port || "22";
      usernameInput.value = el.dataset.username || "";
      profileNameInput.value = el.dataset.name || "";
      
      // Try to get saved password from keyring
      const profileName = el.dataset.name || "";
      if (profileName) {
        try {
          const savedPassword = await invoke<string | null>("get_profile_password", { 
            profileName: profileName 
          });
          
          if (savedPassword) {
            passwordInput.value = savedPassword;
          } else {
            passwordInput.value = "";
          }
        } catch (error) {
          console.error("Failed to get saved password:", error);
          passwordInput.value = "";
        }
      } else {
        passwordInput.value = "";
      }
      
      // Highlight selected profile
      profilesList.querySelectorAll(".profile-item").forEach((p) => p.classList.remove("selected"));
      item.classList.add("selected");
      selectedSavedProfile = el.dataset.name || null;
      updateRememberCheckbox();
      
      passwordInput.focus();
    });
    

    // Delete Profile Button
    const deleteBtn = item.querySelector(".profile-item-delete");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const name = (e.target as HTMLElement).getAttribute("data-name")!;
        const confirmed = confirm(`Delete profile "${name}"?`);
        if (confirmed) {
          try {
            await invoke("delete_profile", { name });
            await renderProfiles();
          } catch (error) {
            alert(`Failed to delete profile: ${error}`);
          }
        }
      });
    }
  });
}


function showToast(message: string, type: "success" | "error" = "success", duration = 3000) {
  const container = document.getElementById("toast-container")!;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = "toast-out 0.2s ease-out forwards";
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

  function updateRememberCheckbox() {
    const isEnabled = selectedSavedProfile !== null;
  
    rememberCheckbox.disabled = !isEnabled;
    rememberLabel.classList.toggle("disabled", !isEnabled);
    
    // Update label text
    rememberLabel.textContent = isEnabled 
      ? "Remember password" 
      : "Remember password (save profile first)";
  }


