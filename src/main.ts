import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

let currentPath = "/";
let currentZoom = 1;

let connectionPanel: HTMLElement;
let browserPanel: HTMLElement;
let statusDiv: HTMLElement;
let fileListDiv: HTMLElement;
let pathInput: HTMLInputElement;
let connectedToSpan: HTMLElement;

window.addEventListener("DOMContentLoaded", () => {
  connectionPanel = document.querySelector("#connection-panel")!;
  browserPanel = document.querySelector("#browser-panel")!;
  statusDiv = document.querySelector("#status")!;
  fileListDiv = document.querySelector("#file-list")!;
  pathInput = document.querySelector("#current-path")!;
  connectedToSpan = document.querySelector("#connected-to")!;

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

  // Zoom controls
  function updateZoom(delta: number) {
    currentZoom = Math.max(0.75, Math.min(1.5, currentZoom + delta));
    document.documentElement.style.setProperty("--zoom", currentZoom.toString());
    zoomLevelSpan.textContent = Math.round(currentZoom * 100) + "%";
  }

  zoomInBtn.addEventListener("click", () => updateZoom(0.1));
  zoomOutBtn.addEventListener("click", () => updateZoom(-0.1));

// Port toggle (password-style reveal)
  togglePortBtn.addEventListener("click", () => {
    if (portInput.type === "password") {
      portInput.type = "text";
      togglePortBtn.textContent = "🙈";
    } else {
      portInput.type = "password";
      togglePortBtn.textContent = "👁️";
    }
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

  // Enter key to connect from any input field
  [hostInput, portInput, usernameInput, passwordInput].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        connectBtn.click();
      }
    });
  });

  // Disconnect button
  disconnectBtn.addEventListener("click", () => {
    browserPanel.classList.add("hidden");
    connectionPanel.classList.remove("hidden");
    statusDiv.textContent = "";
  });

  // Go button
  goBtn.addEventListener("click", () => {
    loadDirectory(pathInput.value);
  });

  // Up button
  upBtn.addEventListener("click", () => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const parentPath = "/" + parts.join("/");
    loadDirectory(parentPath || "/");
  });

  // Refresh button
  refreshBtn.addEventListener("click", () => {
    loadDirectory(currentPath);
  });

  // Upload button
  uploadBtn.addEventListener("click", async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
      });

      if (selected) {
        const localPath = selected as string;
        const fileName = localPath.split(/[/\\]/).pop() || "uploaded_file";
        await uploadFile(localPath, fileName);
      }
    } catch (error) {
      alert(`Error selecting file: ${error}`);
    }
  });

  // Enter key in path input
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      loadDirectory(pathInput.value);
    }
  });
});

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
            <button class="download-btn">${file.is_dir ? "Download Folder" : "Download"}</button>
          </div>
        `;
      })
      .join("");

    fileListDiv.querySelectorAll(".file-item").forEach((item) => {
      const name = item.getAttribute("data-name")!;
      const isDir = item.getAttribute("data-is-dir") === "true";
      const newPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;

      // Click on row to navigate (directories only)
      if (isDir) {
        item.addEventListener("click", (e) => {
          if (!(e.target as HTMLElement).classList.contains("download-btn")) {
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
            showConfirmDialog(
              "Download Directory?",
              `Downloading entire directories is not yet supported. This feature is coming soon!`,
              false
            );
          } else {
            downloadFile(newPath, name);
          }
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
          <button class="btn-cancel">${showConfirm ? "Cancel" : "OK"}</button>
          ${showConfirm ? '<button class="btn-confirm">Confirm</button>' : ""}
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

async function uploadFile(localPath: string, fileName: string) {
  const remotePath =
    currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;

  try {
    const result = await invoke<string>("upload_file", {
      localPath,
      remotePath,
    });
    alert(`Success! ${result}\nSaved to: ${remotePath}`);
    await loadDirectory(currentPath);
  } catch (error) {
    alert(`Upload Failed: ${error}`);
  }
}