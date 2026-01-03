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

let currentPath = "/";
let currentZoom = 1;

// Upload queue
let uploadQueue: QueuedFile[] = [];
let isProcessingQueue = false;
const MAX_CONCURRENT_UPLOADS = 2;
let activeUploads = 0;

// DOM Elements
let connectionPanel: HTMLElement;
let browserPanel: HTMLElement;
let statusDiv: HTMLElement;
let fileListDiv: HTMLElement;
let pathInput: HTMLInputElement;
let connectedToSpan: HTMLElement;
let dropZone: HTMLElement;
let uploadQueueDiv: HTMLElement;
let queueListDiv: HTMLElement;
let queueStatusSpan: HTMLElement;

window.addEventListener("DOMContentLoaded", () => {
  connectionPanel = document.querySelector("#connection-panel")!;
  browserPanel = document.querySelector("#browser-panel")!;
  statusDiv = document.querySelector("#status")!;
  fileListDiv = document.querySelector("#file-list")!;
  pathInput = document.querySelector("#current-path")!;
  connectedToSpan = document.querySelector("#connected-to")!;
  dropZone = document.querySelector("#drop-zone")!;
  uploadQueueDiv = document.querySelector("#upload-queue")!;
  queueListDiv = document.querySelector("#queue-list")!;
  queueStatusSpan = document.querySelector("#queue-status")!;

  const hostInput = document.querySelector<HTMLInputElement>("#host")!;
  const portInput = document.querySelector<HTMLInputElement>("#port")!;
  const usernameInput = document.querySelector<HTMLInputElement>("#username")!;
  const passwordInput = document.querySelector<HTMLInputElement>("#password")!;
  const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
  const disconnectBtn = document.querySelector<HTMLButtonElement>("#disconnect-btn")!;
  const upBtn = document.querySelector<HTMLButtonElement>("#up-btn")!;
  const goBtn = document.querySelector<HTMLButtonElement>("#go-btn")!;
  const uploadBtn = document.querySelector<HTMLButtonElement>("#upload-btn")!;
  const refreshBtn = document.querySelector<HTMLButtonElement>("#refresh-btn")!;
  const togglePortBtn = document.querySelector<HTMLButtonElement>("#toggle-port")!;
  const zoomInBtn = document.querySelector<HTMLButtonElement>("#zoom-in")!;
  const zoomOutBtn = document.querySelector<HTMLButtonElement>("#zoom-out")!;
  const zoomLevelSpan = document.querySelector<HTMLSpanElement>("#zoom-level")!;

  // Listen for upload progress events from Rust
  setupProgressListener();
  
  // Listen for drag-drop events from Tauri
  setupTauriDragDrop();

  // Zoom controls
  function updateZoom(delta: number) {
    currentZoom = Math.max(0.75, Math.min(1.5, currentZoom + delta));
    document.documentElement.style.setProperty("--zoom", currentZoom.toString());
    zoomLevelSpan.textContent = Math.round(currentZoom * 100) + "%";
  }

  zoomInBtn.addEventListener("click", () => updateZoom(0.1));
  zoomOutBtn.addEventListener("click", () => updateZoom(-0.1));

  // Port toggle
  togglePortBtn.addEventListener("click", () => {
    if (portInput.type === "password") {
      portInput.type = "text";
      togglePortBtn.textContent = "Hide";
    } else {
      portInput.type = "password";
      togglePortBtn.textContent = "Show";
    }
  });

  // Enter key to connect
  [hostInput, portInput, usernameInput, passwordInput].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        connectBtn.click();
      }
    });
  });

  // Connect button
  connectBtn.addEventListener("click", async () => {
    const host = hostInput.value;
    const port = parseInt(portInput.value) || 22;
    const username = usernameInput.value;
    const password = passwordInput.value;

    if (!host || !username || !password) {
      statusDiv.textContent = "Please fill in all fields";
      statusDiv.className = "error";
      return;
    }

    statusDiv.textContent = "Connecting...";
    statusDiv.className = "";
    connectBtn.disabled = true;

    try {
      await invoke("connect", { host, port, username, password });

      connectedToSpan.textContent = `Connected to ${host}`;
      connectionPanel.classList.add("hidden");
      browserPanel.classList.remove("hidden");

      await loadDirectory("/");
    } catch (error) {
      statusDiv.textContent = `${error}`;
      statusDiv.className = "error";
    } finally {
      connectBtn.disabled = false;
    }
  });

  // Disconnect button
  disconnectBtn.addEventListener("click", () => {
    browserPanel.classList.add("hidden");
    connectionPanel.classList.remove("hidden");
    statusDiv.textContent = "";
    uploadQueue = [];
    renderQueue();
  });

  // Go button
  goBtn.addEventListener("click", () => loadDirectory(pathInput.value));

  // Up button
  upBtn.addEventListener("click", () => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const parentPath = "/" + parts.join("/");
    loadDirectory(parentPath || "/");
  });

  // Refresh button
  refreshBtn.addEventListener("click", () => loadDirectory(currentPath));

  // Upload button (multiple files)
  uploadBtn.addEventListener("click", async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
      });

      if (selected) {
        // Ensure we always have an array
        const files = Array.isArray(selected) ? selected : [selected];
        if (files.length > 0) {
          queueFilesForUpload(files);
        }
      }
    } catch (error) {
      alert(`Error selecting files: ${error}`);
    }
  });

  // Path input enter key
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      loadDirectory(pathInput.value);
    }
  });

  // Visual drag feedback for drop zone
  setupDropZoneVisuals();
});

// ============ TAURI DRAG & DROP ============

function setupTauriDragDrop() {
  // Listen for files dropped from Windows Explorer / file manager
  listen<DragDropEvent>("tauri://drag-drop", (event) => {
    const paths = event.payload.paths;
    
    if (paths && paths.length > 0) {
      // Check if browser panel is visible (user is connected)
      if (!browserPanel.classList.contains("hidden")) {
        queueFilesForUpload(paths);
      } else {
        alert("Please connect to a server first before uploading files.");
      }
    }
  });

  // Visual feedback when dragging over the window
  listen("tauri://drag-enter", () => {
    if (!browserPanel.classList.contains("hidden")) {
      dropZone.classList.add("drag-over");
    }
  });

  listen("tauri://drag-leave", () => {
    dropZone.classList.remove("drag-over");
  });

  listen("tauri://drag-over", () => {
    // Keep the visual feedback while dragging over
  });
}

function setupDropZoneVisuals() {
  // These handle browser-level drag events for visual feedback
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

// ============ UPLOAD QUEUE ============

function queueFilesForUpload(filePaths: string[]) {
  for (const localPath of filePaths) {
    const fileName = localPath.split(/[/\\]/).pop() || "unknown";
    const remotePath =
      currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;

    const queuedFile: QueuedFile = {
      id: crypto.randomUUID(),
      localPath,
      fileName,
      remotePath,
      status: "pending",
      progress: 0,
    };

    uploadQueue.push(queuedFile);
  }

  renderQueue();
  processQueue();
}

function renderQueue() {
  if (uploadQueue.length === 0) {
    uploadQueueDiv.classList.add("hidden");
    return;
  }

  uploadQueueDiv.classList.remove("hidden");

  const pending = uploadQueue.filter((f) => f.status === "pending").length;
  const uploading = uploadQueue.filter((f) => f.status === "uploading").length;
  const complete = uploadQueue.filter((f) => f.status === "complete").length;
  const errors = uploadQueue.filter((f) => f.status === "error").length;

  queueStatusSpan.textContent = `${complete}/${uploadQueue.length} complete${
    errors > 0 ? `, ${errors} failed` : ""
  }`;

  queueListDiv.innerHTML = uploadQueue
    .map((file) => {
      let statusIcon = "";
      let statusClass = "";

      switch (file.status) {
        case "pending":
          statusIcon = "⏳";
          statusClass = "pending";
          break;
        case "uploading":
          statusIcon = "📤";
          statusClass = "uploading";
          break;
        case "complete":
          statusIcon = "✅";
          statusClass = "complete";
          break;
        case "error":
          statusIcon = "❌";
          statusClass = "error";
          break;
      }

      return `
        <div class="queue-item ${statusClass}" data-id="${file.id}">
          <div class="queue-item-info">
            <span class="queue-item-icon">${statusIcon}</span>
            <span class="queue-item-name" title="${file.fileName}">${file.fileName}</span>
            ${file.error ? `<span class="queue-item-error">${file.error}</span>` : ""}
          </div>
          <div class="queue-item-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${file.progress}%"></div>
            </div>
            <span class="progress-text">${file.progress}%</span>
          </div>
          ${file.status === "pending" ? `<button class="queue-remove-btn" data-id="${file.id}">✕</button>` : ""}
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

  const allComplete = uploadQueue.every(
    (f) => f.status === "complete" || f.status === "error"
  );
  if (allComplete && uploadQueue.length > 0) {
    await loadDirectory(currentPath);
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

// ============ FILE BROWSER ============

async function loadDirectory(path: string) {
  try {
    fileListDiv.innerHTML = "<div class='loading'>Loading...</div>";

    const files = await invoke<FileEntry[]>("list_dir", { path });

    currentPath = path;
    pathInput.value = path;

    files.sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name);
    });

    if (files.length === 0) {
      fileListDiv.innerHTML = "<div class='empty'>Empty directory</div>";
      return;
    }

    fileListDiv.innerHTML = files
      .map((file) => {
        const icon = file.is_dir ? "📁" : "📄";
        const sizeText = file.is_dir ? "" : ` (${formatSize(file.size)})`;
        return `
          <div class="file-item ${file.is_dir ? "directory" : "file"}"
               data-name="${file.name}"
               data-is-dir="${file.is_dir}">
            <span class="file-info">${icon} ${file.name}${sizeText}</span>
            <div class="file-actions">
              <button class="download-btn">${file.is_dir ? "Download" : "Download"}</button>
              <button class="delete-btn danger">Delete</button>
            </div>
          </div>
        `;
      })
      .join("");

    fileListDiv.querySelectorAll(".file-item").forEach((item) => {
      const name = item.getAttribute("data-name")!;
      const isDir = item.getAttribute("data-is-dir") === "true";
      const newPath =
        currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;

      // Click on directory row to navigate
      if (isDir) {
        item.addEventListener("click", (e) => {
          const target = e.target as HTMLElement;
          if (!target.classList.contains("download-btn") && 
              !target.classList.contains("delete-btn")) {
            loadDirectory(newPath);
          }
        });
      }

      // Download button
      const downloadBtn = item.querySelector(".download-btn");
      if (downloadBtn) {
        downloadBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (isDir) {
            alert("Downloading entire directories is not yet supported.");
          } else {
            downloadFile(newPath, name);
          }
        });
      }

      // Delete button
      const deleteBtn = item.querySelector(".delete-btn");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          confirmDelete(newPath, name, isDir);
        });
      }
    });
  } catch (error) {
    fileListDiv.innerHTML = `<div class="error">Error: ${error}</div>`;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

async function downloadFile(remotePath: string, fileName: string) {
  const localPath = `/tmp/${fileName}`;

  try {
    const result = await invoke<string>("download_file", {
      remotePath,
      localPath,
    });
    alert(`Success! ${result}\nSaved to: ${localPath}`);
  } catch (error) {
    alert(`Download failed: ${error}`);
  }
}

async function confirmDelete(remotePath: string, name: string, isDir: boolean) {
  const typeText = isDir ? "directory" : "file";
  const confirmed = await showConfirmDialog(
    `Delete ${typeText}?`,
    `Are you sure you want to delete "${name}"?${isDir ? "\n\nNote: Directory must be empty to delete." : ""}`,
    true
  );

  if (confirmed) {
    try {
      const result = await invoke<string>("delete_file", { remotePath });
      await loadDirectory(currentPath);
    } catch (error) {
      alert(`Delete failed: ${error}`);
    }
  }
}

function showConfirmDialog(
  title: string,
  message: string,
  showConfirm: boolean = true
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <h3>${title}</h3>
        <p>${message}</p>
        <div class="buttons">
          <button class="btn-cancel">Cancel</button>
          ${showConfirm ? '<button class="btn-confirm danger">Delete</button>' : ""}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector(".btn-cancel")!.addEventListener("click", () => {
      document.body.removeChild(overlay);
      resolve(false);
    });

    if (showConfirm) {
      overlay.querySelector(".btn-confirm")!.addEventListener("click", () => {
        document.body.removeChild(overlay);
        resolve(true);
      });
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        resolve(false);
      }
    });
  });
}