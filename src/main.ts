import { invoke } from "@tauri-apps/api/core";

// Track current path
let currentPath = "/";

// DOM Elements
let connectionPanel: HTMLElement;
let browserPanel: HTMLElement;
let statusDiv: HTMLElement;
let fileListDiv: HTMLElement;
let pathInput: HTMLInputElement;
let connectedToSpan: HTMLElement;

window.addEventListener("DOMContentLoaded", () => {
  // Get all elements
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

    try {
      await invoke("connect", { host, port, username, password });
      
      // Success! Show browser panel
      connectedToSpan.textContent = `Connected to ${host}`;
      connectionPanel.classList.add("hidden");
      browserPanel.classList.remove("hidden");
      
      // Load root directory
      await loadDirectory("/");
    } catch (error) {
      statusDiv.textContent = `Error: ${error}`;
      statusDiv.className = "error";
    }
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
    
    const files = await invoke<string[]>("list_dir", { path });
    
    currentPath = path;
    pathInput.value = path;
    
    // Sort: folders might come mixed, we'll display all the same for now
    files.sort();
    
    if (files.length === 0) {
      fileListDiv.innerHTML = "<div class='empty'>Empty directory</div>";
      return;
    }

    fileListDiv.innerHTML = files
      .map(name => `<div class="file-item" data-name="${name}">📄 ${name}</div>`)
      .join("");

    // Add click handlers to each item
    fileListDiv.querySelectorAll(".file-item").forEach(item => {
      item.addEventListener("click", () => {
        const name = item.getAttribute("data-name")!;
        const newPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
        loadDirectory(newPath);
      });
    });

  } catch (error) {
    fileListDiv.innerHTML = `<div class="error">Error: ${error}</div>`;
  }
}