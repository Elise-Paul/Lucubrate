/**
 * Lucubrate IDE Client Controller (v1.3)
 * VS Code Dark Modern Theme + Hierarchical Recursive File Tree
 */

const state = {
    demoMode: (localStorage.getItem("lucubrate_demo_mode") === "true"),
    currentPath: "",
    treeData: {},       // path -> { name, path, is_dir, expanded, loaded, children, level }
    selectedPath: null,
    selectedNode: null,
    inlineCreation: null,   // { parentPath, isDir, level }
    inlineRename: null,     // { path, originalName }
    contextMenuTarget: null,
    chatContextFiles: [],   // [ { path, name, is_dir } ]
    openTabs: {},       // path -> { model, dirty, originalContent }
    activeTab: null,
    editor: null,
    terminals: {},      // id -> { id, name, term, ws, pane }
    activeTerminalId: null,
    terminalIdCounter: 0,
    autocompleteEnabled: (localStorage.getItem("lucubrate_autocomplete_enabled") || localStorage.getItem("spark_autocomplete_enabled")) !== "false",
    showHiddenFiles: (localStorage.getItem("lucubrate_show_hidden_files") || localStorage.getItem("spark_show_hidden_files")) === "true",
    selectedModel: (localStorage.getItem("lucubrate_selected_model") || localStorage.getItem("spark_selected_model")) || "Qwen/Qwen2.5-Coder-7B-Instruct",
    agentHistory: [],
    config: {
        remote_host: "",
        remote_user: "",
        remote_key_path: "",
        remote_port: 22,
        spark_host: "",
        spark_user: "",
        spark_key_path: "",
        spark_port: 22,
        model_url: "",
        remote_root: ""
    }
};

document.addEventListener("DOMContentLoaded", async () => {
    // 1. Load active configuration from backend
    try {
        const cfgResp = await fetch("/api/config");
        if (cfgResp.ok) {
            state.config = await cfgResp.json();
            const host = state.config.remote_host || state.config.spark_host || "--";
            const user = state.config.remote_user || state.config.spark_user || "";
            state.currentPath = state.config.remote_root || "";
            document.getElementById("nav-host-display").textContent = host;
            document.getElementById("metric-ip").textContent = host;
            document.getElementById("term-user-host").textContent = user ? `${user}@${host}` : "Terminal";
        }
    } catch (e) {
        console.warn("Could not load config", e);
    }

    // 2. Start hardware telemetry polling immediately
    initTelemetry();

    // 3. Initialize VS Code style Hierarchical File Tree
    updateHiddenFilesBtn();
    initFileTreeRoot(state.currentPath);

    // 4. Load models from Spark
    loadModels();

    // 5. Initialize terminal with local xterm.js
    try {
        initTerminal();
    } catch (e) {
        console.error("Terminal init failed:", e);
    }

    // 6. Initialize Monaco Editor in VS-DARK theme
    try {
        initMonaco();
    } catch (e) {
        console.error("Monaco init failed:", e);
    }

    // 7. Initialize agent chat & search
    initAgentChat();
    initSearchBar();
    initKeyboardShortcuts();
    initColumnResizers();

    // 8. Initialize global UI zoom (Ctrl + MouseWheel & shortcuts)
    initZoom();

    // 9. Update Autocomplete navbar radio indicator
    updateAutocompleteUI();

    // 10. Global listeners for File Explorer Context Menu and Inline Creation
    document.addEventListener("click", (e) => {
        const menu = document.getElementById("explorer-context-menu");
        if (menu && menu.style.display !== "none" && !menu.contains(e.target)) {
            menu.style.display = "none";
        }
    });

    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            const menu = document.getElementById("explorer-context-menu");
            if (menu && menu.style.display !== "none") {
                menu.style.display = "none";
            }
            if (state.inlineCreation) {
                cancelInlineCreation();
            }
            if (state.inlineRename) {
                cancelInlineRename();
            }
        }
    });

    const fileTreeContainer = document.getElementById("file-tree-container");
    if (fileTreeContainer) {
        fileTreeContainer.addEventListener("contextmenu", (e) => {
            if (e.target === fileTreeContainer) {
                showExplorerContextMenu(e, null);
            }
        });
    }
});

// --- Hardware Telemetry Polling ---
function initTelemetry() {
    const poll = async () => {
        if (state.demoMode) {
            document.getElementById("metric-ip").textContent = "192.168.1.100";
            document.getElementById("metric-temp").textContent = "39°C";
            document.getElementById("metric-vram").textContent = "18,642 MB";
            document.getElementById("metric-total-vram").textContent = "124,546 MB";
            document.getElementById("metric-power").textContent = "7.8 W";
            const modelEl = document.getElementById("metric-model");
            if (modelEl) modelEl.textContent = (typeof DEMO_MODEL_NAME !== "undefined") ? DEMO_MODEL_NAME : "Qwen/Qwen2.5-Coder-32B-Instruct";
            document.getElementById("nav-host-display").textContent = "192.168.1.100";
            const statusDot = document.getElementById("nav-status-dot");
            const hostStatus = document.getElementById("nav-host-status");
            if (statusDot) statusDot.style.backgroundColor = "#28a745";
            if (hostStatus) { hostStatus.textContent = "ONLINE"; hostStatus.style.color = "#4ec9b0"; }
            return;
        }
        try {
            const resp = await fetch("/api/telemetry");
            if (!resp.ok) throw new Error("Telemetry response not ok");
            const data = await resp.json();

            document.getElementById("metric-ip").textContent = data.ip || state.config.remote_host || state.config.spark_host || "--";
            document.getElementById("metric-temp").textContent = data.temp || "--°C";
            document.getElementById("metric-vram").textContent = data.used_mem || "-- MB";
            document.getElementById("metric-total-vram").textContent = data.total_mem || "124,546 MB";
            document.getElementById("metric-power").textContent = data.power || "-- W";

            const statusDot = document.getElementById("nav-status-dot");
            const hostStatus = document.getElementById("nav-host-status");
            if (data.status === "ONLINE") {
                statusDot.style.backgroundColor = "#28a745";
                hostStatus.textContent = "ONLINE";
                hostStatus.style.color = "#4ec9b0";
            } else {
                statusDot.style.backgroundColor = "#dc3545";
                hostStatus.textContent = "OFFLINE";
                hostStatus.style.color = "#f97583";
            }
        } catch (e) {
            console.warn("Telemetry poll error:", e);
            document.getElementById("nav-status-dot").style.backgroundColor = "#dc3545";
            document.getElementById("nav-host-status").textContent = "OFFLINE";
        }
    };

    poll();
    setInterval(poll, 3000);
}

async function inspectGpuDetails() {
    try {
        const resp = await fetch("/api/gpu/inspect");
        const data = await resp.json();
        if (state.term) {
            const drawer = document.getElementById("terminal-drawer");
            if (drawer.classList.contains("collapsed")) {
                drawer.classList.remove("collapsed");
            }
            state.term.write("\r\n\x1b[36m" + data.output.replace(/\n/g, "\r\n") + "\x1b[0m\r\n");
        } else {
            alert(data.output);
        }
    } catch (e) {
        alert("Failed to query nvidia-smi: " + e.message);
    }
}

// --- VS Code Style Hierarchical File Tree ---
async function refreshExplorerTree() {
    if (state.demoMode) {
        initDemoTree();
        return;
    }
    await initFileTreeRoot(state.currentPath);
}

async function initFileTreeRoot(rootPath) {
    state.currentPath = rootPath || state.config.remote_root || "";
    document.getElementById("current-path-display").textContent = state.currentPath;

    const container = document.getElementById("file-tree-container");
    container.innerHTML = `<div style="padding: 10px; color: #888888; font-size: 11px;">Loading ${state.currentPath}...</div>`;

    state.treeData = {
        [state.currentPath]: {
            name: state.currentPath.split("/").pop() || state.currentPath,
            path: state.currentPath,
            is_dir: true,
            expanded: true,
            loaded: false,
            children: [],
            level: 0
        }
    };

    await loadNodeChildren(state.currentPath);
    renderFullTree();
}

async function loadNodeChildren(dirPath) {
    if (state.demoMode) {
        if (DEMO_TREE_DATA[dirPath]) {
            state.treeData[dirPath] = JSON.parse(JSON.stringify(DEMO_TREE_DATA[dirPath]));
            state.treeData[dirPath].children.forEach(c => {
                if (!state.treeData[c.path]) {
                    state.treeData[c.path] = JSON.parse(JSON.stringify(c));
                }
            });
        }
        return;
    }
    try {
        const resp = await fetch(`/api/fs/list?path=${encodeURIComponent(dirPath)}`);
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || "Failed to list directory");
        }
        const data = await resp.json();
        const parentLevel = state.treeData[dirPath] ? state.treeData[dirPath].level : 0;

        const children = [];
        data.items.forEach(item => {
            const node = {
                name: item.name,
                path: item.path,
                is_dir: item.is_dir,
                is_symlink: item.is_symlink || false,
                size: item.size,
                expanded: state.treeData[item.path]?.expanded || false,
                loaded: state.treeData[item.path]?.loaded || false,
                children: state.treeData[item.path]?.children || [],
                level: parentLevel + 1
            };
            state.treeData[item.path] = node;
            children.push(node);
        });

        if (state.treeData[dirPath]) {
            state.treeData[dirPath].children = children;
            state.treeData[dirPath].loaded = true;
        }
    } catch (e) {
        console.error("Error loading directory", dirPath, e);
    }
}

function selectTreeNode(node) {
    state.selectedNode = node;
    state.selectedPath = node ? node.path : null;
    document.querySelectorAll(".tree-node-row").forEach(r => r.classList.remove("selected"));
    if (node) {
        const row = document.getElementById(`tree-row-${btoa(node.path).replace(/=/g, '')}`);
        if (row) row.classList.add("selected");
    }
}

function renderFullTree() {
    const container = document.getElementById("file-tree-container");
    container.innerHTML = "";
    const rootNode = state.treeData[state.currentPath];
    if (!rootNode) return;

    // If inline creation at root level, render at top of container
    if (state.inlineCreation && state.inlineCreation.parentPath === state.currentPath) {
        container.appendChild(createInlineInputRow(state.inlineCreation));
    }

    renderNodeRecursively(rootNode, container, true);

    // Auto-focus any inline input if present
    setTimeout(() => {
        const input = document.getElementById("tree-inline-input");
        if (input && typeof input.focus === "function") {
            input.focus();
            if (typeof input.select === "function") input.select();
        }
    }, 25);
}

function renderNodeRecursively(node, parentElement, isRoot = false) {
    if (!isRoot) {
        const isRenaming = state.inlineRename && state.inlineRename.path === node.path;
        const isSelected = state.selectedPath === node.path;
        const isActiveTab = state.activeTab === node.path;

        const row = document.createElement("div");
        row.className = "tree-node-row" + (isActiveTab ? " active" : "") + (isSelected ? " selected" : "");
        row.style.paddingLeft = `${node.level * 14}px`;
        row.id = `tree-row-${btoa(node.path).replace(/=/g, '')}`;

        // Enable dragging to Agent Chat (Cursor style)
        row.draggable = true;
        row.ondragstart = (e) => {
            const dragPayload = {
                type: "spark-fs-node",
                path: node.path,
                name: node.name,
                is_dir: node.is_dir
            };
            e.dataTransfer.setData("application/json", JSON.stringify(dragPayload));
            e.dataTransfer.setData("text/plain", node.path);
            e.dataTransfer.effectAllowed = "copy";
            row.classList.add("dragging");
        };
        row.ondragend = () => {
            row.classList.remove("dragging");
        };

        // Chevron
        const chevron = document.createElement("span");
        chevron.className = "tree-chevron" + (node.expanded ? " expanded" : "");
        chevron.innerHTML = node.is_dir ? "▶" : "&nbsp;";
        chevron.onclick = async (e) => {
            e.stopPropagation();
            if (node.is_dir) {
                if (!node.loaded) {
                    await loadNodeChildren(node.path);
                }
                node.expanded = !node.expanded;
                renderFullTree();
            }
        };
        row.appendChild(chevron);

        // Icon
        const icon = document.createElement("span");
        icon.className = `tree-icon ${getFileIconClass(node.name, node.is_dir)}`;
        icon.innerHTML = getFileIconSymbol(node.name, node.is_dir);
        row.appendChild(icon);

        if (isRenaming) {
            // Inline rename input
            const renameInput = document.createElement("input");
            renameInput.id = "tree-inline-input";
            renameInput.className = "tree-inline-input";
            renameInput.value = node.name;
            renameInput.spellcheck = false;
            renameInput.onclick = (e) => e.stopPropagation();
            renameInput.onkeydown = (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    commitInlineRename();
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelInlineRename();
                }
            };
            renameInput.onblur = () => {
                setTimeout(() => {
                    if (state.inlineRename) commitInlineRename();
                }, 150);
            };
            row.appendChild(renameInput);
        } else {
            // Label
            const label = document.createElement("span");
            label.className = "tree-label";
            label.textContent = node.name;
            row.appendChild(label);
        }

        // Click Handler
        row.onclick = async (e) => {
            e.stopPropagation();
            selectTreeNode(node);
            if (node.is_dir) {
                if (!node.loaded) {
                    await loadNodeChildren(node.path);
                }
                node.expanded = !node.expanded;
                renderFullTree();
            } else {
                openFileInEditor(node.path);
            }
        };

        // Context Menu Handler
        row.oncontextmenu = (e) => {
            showExplorerContextMenu(e, node);
        };

        row.title = `${node.path} (${node.is_dir ? (node.is_symlink ? 'Symlink Directory' : 'Directory') : node.size + ' bytes'})`;
        parentElement.appendChild(row);
    }

    // Children container if expanded
    if (node.is_dir && node.expanded) {
        const childrenContainer = document.createElement("div");
        childrenContainer.className = "tree-children-container";

        // If inline creation inside this directory, place at top of children
        if (state.inlineCreation && state.inlineCreation.parentPath === node.path) {
            childrenContainer.appendChild(createInlineInputRow(state.inlineCreation));
        }

        if (node.children && node.children.length > 0) {
            const filteredChildren = state.showHiddenFiles
                ? node.children
                : node.children.filter(child => !child.name.startsWith("."));
            filteredChildren.forEach(child => {
                renderNodeRecursively(child, childrenContainer, false);
            });
        }
        parentElement.appendChild(childrenContainer);
    }
}

function toggleHiddenFiles() {
    state.showHiddenFiles = !state.showHiddenFiles;
    localStorage.setItem("spark_show_hidden_files", state.showHiddenFiles ? "true" : "false");
    updateHiddenFilesBtn();
    renderFullTree();
}

function updateHiddenFilesBtn() {
    const btn = document.getElementById("btn-toggle-hidden-files");
    if (!btn) return;
    if (state.showHiddenFiles) {
        btn.textContent = "🔓";
        btn.title = "Private / Dot Folders Visible (Click to Lock / Hide)";
        btn.classList.add("unlocked");
    } else {
        btn.textContent = "🔒";
        btn.title = "Private / Dot Folders Hidden (Click to Unlock / Show)";
        btn.classList.remove("unlocked");
    }
}

function getFileIconClass(name, isDir) {
    if (isDir) return "dir";
    const ext = name.split(".").pop().toLowerCase();
    if (ext === "py") return "py";
    if (ext === "sh" || ext === "bash") return "sh";
    if (ext === "json" || ext === "yaml" || ext === "yml") return "json";
    if (ext === "md") return "md";
    return "file";
}

function getFileIconSymbol(name, isDir) {
    if (isDir) return "📁";
    const ext = name.split(".").pop().toLowerCase();
    if (ext === "py") return "🐍";
    if (ext === "sh") return "⚙";
    if (ext === "json" || ext === "yaml" || ext === "yml") return "{}";
    if (ext === "md") return "📝";
    return "📄";
}

function createInlineInputRow(creationData) {
    const row = document.createElement("div");
    row.className = "tree-inline-row";
    row.style.paddingLeft = `${creationData.level * 14}px`;

    const chevron = document.createElement("span");
    chevron.className = "tree-chevron";
    chevron.innerHTML = "&nbsp;";
    row.appendChild(chevron);

    const icon = document.createElement("span");
    icon.className = `tree-icon ${creationData.isDir ? 'dir' : 'file'}`;
    icon.innerHTML = creationData.isDir ? "📁" : "📄";
    row.appendChild(icon);

    const input = document.createElement("input");
    input.id = "tree-inline-input";
    input.className = "tree-inline-input";
    input.placeholder = creationData.isDir ? "Folder name..." : "File name...";
    input.spellcheck = false;

    input.onkeydown = (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            commitInlineCreation();
        } else if (e.key === "Escape") {
            e.preventDefault();
            cancelInlineCreation();
        }
    };

    input.onblur = () => {
        setTimeout(() => {
            if (state.inlineCreation) {
                const val = input.value.trim();
                if (val) {
                    commitInlineCreation();
                } else {
                    cancelInlineCreation();
                }
            }
        }, 150);
    };

    row.appendChild(input);
    return row;
}

async function startInlineCreation(isDir, fromNode = null) {
    let targetDir = state.currentPath;
    let level = 1;

    const baseNode = fromNode || state.selectedNode;
    if (baseNode) {
        if (baseNode.is_dir) {
            targetDir = baseNode.path;
            level = baseNode.level + 1;
            baseNode.expanded = true;
            if (!baseNode.loaded) {
                await loadNodeChildren(baseNode.path);
            }
        } else {
            targetDir = baseNode.path.substring(0, baseNode.path.lastIndexOf("/")) || state.currentPath;
            level = baseNode.level;
            const parentNode = state.treeData[targetDir];
            if (parentNode) {
                parentNode.expanded = true;
            }
        }
    } else {
        const rootNode = state.treeData[state.currentPath];
        if (rootNode) rootNode.expanded = true;
    }

    state.inlineCreation = { parentPath: targetDir, isDir: isDir, level: level };
    renderFullTree();
}

function cancelInlineCreation() {
    state.inlineCreation = null;
    renderFullTree();
}

async function commitInlineCreation() {
    if (!state.inlineCreation) return;
    const input = document.getElementById("tree-inline-input");
    if (!input) return;

    const name = input.value.trim().replace(/^[\\\/]+|[\\\/]+$/g, "");
    if (!name) {
        cancelInlineCreation();
        return;
    }

    const parentPath = state.inlineCreation.parentPath;
    const isDir = state.inlineCreation.isDir;
    const fullPath = (parentPath.endsWith("/") ? parentPath : parentPath + "/") + name;

    try {
        const resp = await fetch("/api/fs/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: fullPath, is_dir: isDir })
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || "Failed to create item");
        }

        state.inlineCreation = null;
        await loadNodeChildren(parentPath);
        renderFullTree();

        if (state.treeData[fullPath]) {
            selectTreeNode(state.treeData[fullPath]);
        }

        if (!isDir) {
            await openFileInEditor(fullPath);
        }
    } catch (e) {
        alert("Creation failed: " + e.message);
        cancelInlineCreation();
    }
}

function startInlineRename(node = null) {
    const target = node || state.selectedNode;
    if (!target || target.path === state.currentPath) return;

    state.inlineRename = { path: target.path, originalName: target.name };
    renderFullTree();
}

function cancelInlineRename() {
    state.inlineRename = null;
    renderFullTree();
}

async function commitInlineRename() {
    if (!state.inlineRename) return;
    const input = document.getElementById("tree-inline-input");
    if (!input) return;

    const newName = input.value.trim().replace(/^[\\\/]+|[\\\/]+$/g, "");
    const oldPath = state.inlineRename.path;
    const originalName = state.inlineRename.originalName;

    if (!newName || newName === originalName) {
        cancelInlineRename();
        return;
    }

    const parentDir = oldPath.substring(0, oldPath.lastIndexOf("/")) || state.currentPath;
    const newPath = (parentDir.endsWith("/") ? parentDir : parentDir + "/") + newName;

    try {
        const resp = await fetch("/api/fs/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ old_path: oldPath, new_path: newPath })
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || "Failed to rename item");
        }

        // If file is open in tabs, migrate tab data
        if (state.openTabs[oldPath]) {
            state.openTabs[newPath] = state.openTabs[oldPath];
            delete state.openTabs[oldPath];

            const oldTabEl = document.getElementById(`tab-${btoa(oldPath).replace(/=/g, '')}`);
            if (oldTabEl) {
                oldTabEl.id = `tab-${btoa(newPath).replace(/=/g, '')}`;
                const titleSpan = oldTabEl.querySelector(".tab-title");
                if (titleSpan) titleSpan.textContent = newName;
                const closeBtn = oldTabEl.querySelector(".tab-close");
                if (closeBtn) closeBtn.setAttribute("onclick", `closeTab('${newPath}', event)`);
                oldTabEl.onclick = () => switchActiveTab(newPath);
            }
            if (state.activeTab === oldPath) {
                state.activeTab = newPath;
            }
        }

        state.inlineRename = null;
        await loadNodeChildren(parentDir);
        renderFullTree();

        if (state.treeData[newPath]) {
            selectTreeNode(state.treeData[newPath]);
        }
    } catch (e) {
        alert("Rename failed: " + e.message);
        cancelInlineRename();
    }
}

async function deleteSelectedItem(targetNode = null) {
    const target = targetNode || state.selectedNode;
    if (!target || target.path === state.currentPath) return;

    const itemName = target.name || target.path.split("/").pop();
    const itemType = target.is_dir ? "folder and all its contents" : "file";
    if (!confirm(`Are you sure you want to delete ${itemType} '${itemName}' on the remote host?`)) {
        return;
    }

    try {
        const resp = await fetch("/api/fs/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: target.path, is_dir: target.is_dir })
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || "Failed to delete item");
        }

        // Close tab if deleted file was open
        if (state.openTabs[target.path]) {
            closeTab(target.path);
        }

        const parentDir = target.path.substring(0, target.path.lastIndexOf("/")) || state.currentPath;
        state.selectedNode = null;
        state.selectedPath = null;

        await loadNodeChildren(parentDir);
        renderFullTree();
    } catch (e) {
        alert("Delete failed: " + e.message);
    }
}

// --- Context Menu Management ---
function showExplorerContextMenu(e, node) {
    e.preventDefault();
    e.stopPropagation();

    state.contextMenuTarget = node;
    if (node) {
        selectTreeNode(node);
    }

    const menu = document.getElementById("explorer-context-menu");
    if (!menu) return;

    const openItem = document.getElementById("ctx-open-file");
    const renameItem = document.getElementById("ctx-rename");
    const deleteItem = document.getElementById("ctx-delete");

    if (openItem) openItem.style.display = (node && !node.is_dir) ? "flex" : "none";
    if (renameItem) renameItem.style.display = node ? "flex" : "none";
    if (deleteItem) deleteItem.style.display = (node && node.path !== state.currentPath) ? "flex" : "none";

    menu.style.display = "block";

    let x = e.clientX;
    let y = e.clientY;
    const menuWidth = 215;
    const menuHeight = 220;

    if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 8;
    }
    if (y + menuHeight > window.innerHeight) {
        y = window.innerHeight - menuHeight - 8;
    }

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
}

function handleContextMenuAction(action) {
    const menu = document.getElementById("explorer-context-menu");
    if (menu) menu.style.display = "none";

    const target = state.contextMenuTarget;

    switch (action) {
        case "new-file":
            startInlineCreation(false, target);
            break;
        case "new-folder":
            startInlineCreation(true, target);
            break;
        case "open-file":
            if (target && !target.is_dir) openFileInEditor(target.path);
            break;
        case "open-terminal":
            const targetDir = target 
                ? (target.is_dir ? target.path : target.path.substring(0, target.path.lastIndexOf("/")) || state.currentPath)
                : state.currentPath;
            sendTerminalCommand(`cd "${targetDir}"\n`);
            break;
        case "copy-path":
            const fullPath = target ? target.path : state.currentPath;
            navigator.clipboard.writeText(fullPath);
            break;
        case "copy-relative-path":
            const rawPath = target ? target.path : state.currentPath;
            const relPath = rawPath.startsWith(state.currentPath) 
                ? rawPath.substring(state.currentPath.length).replace(/^\/+/, "")
                : rawPath;
            navigator.clipboard.writeText(relPath || ".");
            break;
        case "rename":
            if (target) startInlineRename(target);
            break;
        case "delete":
            if (target) deleteSelectedItem(target);
            break;
    }
}

function sendTerminalCommand(cmd) {
    const drawer = document.getElementById("terminal-drawer");
    if (drawer && drawer.classList.contains("collapsed")) {
        toggleTerminalDrawer();
    }
    const termId = state.activeTerminalId;
    if (termId && state.terminals[termId]) {
        const termData = state.terminals[termId];
        if (termData.ws && termData.ws.readyState === WebSocket.OPEN) {
            termData.ws.send(cmd.endsWith("\n") ? cmd : cmd + "\n");
            setTimeout(() => {
                if (termData.term) termData.term.focus();
            }, 50);
        }
    }
}

// --- Monaco Editor Setup in VS-DARK Theme ---
function initMonaco() {
    if (typeof require === "undefined") {
        console.warn("Monaco loader not found, using fallback editor");
        useFallbackEditor();
        return;
    }

    try {
        require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
        require(['vs/editor/editor.main'], function () {
            // Use vs-dark theme!
            state.editor = monaco.editor.create(document.getElementById('monaco-editor'), {
                value: "# Lucubrate IDE\n# Select a file from the explorer on the left to begin editing.\n",
                language: 'python',
                theme: 'vs-dark',
                fontSize: 13,
                fontFamily: 'Consolas, Monaco, monospace',
                automaticLayout: true,
                minimap: { enabled: true },
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                renderWhitespace: 'selection',
                inlineSuggest: {
                    enabled: true,
                    mode: 'prefix'
                },
                suggest: {
                    preview: true,
                    showInlineDetails: true
                },
                quickSuggestions: {
                    other: true,
                    comments: false,
                    strings: true
                }
            });

            state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActiveFile);

            // Alt+\ to manually trigger inline ghost-text completion
            state.editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Backslash, () => {
                state.editor.trigger('inlineSuggest', 'editor.action.inlineSuggest.trigger');
            });

            let inlineSuggestTimer = null;
            state.editor.onDidChangeModelContent(() => {
                if (state.activeTab && state.openTabs[state.activeTab]) {
                    const tabData = state.openTabs[state.activeTab];
                    const currentVal = state.editor.getValue();
                    const isDirty = currentVal !== tabData.originalContent;
                    if (tabData.dirty !== isDirty) {
                        tabData.dirty = isDirty;
                        updateTabUI(state.activeTab);
                    }
                }

                // Continuous pass to LLM (Cursor-like inline ghost text trigger)
                if (state.autocompleteEnabled) {
                    clearTimeout(inlineSuggestTimer);
                    inlineSuggestTimer = setTimeout(() => {
                        try {
                            if (state.editor && typeof state.editor.trigger === "function") {
                                state.editor.trigger('typing', 'editor.action.inlineSuggest.trigger', {});
                            }
                        } catch (err) {}
                    }, 250);
                }
            });

            // Inline FIM Autocomplete Provider
            const languages = [
                'python', 'javascript', 'typescript', 'html', 'css', 'json', 
                'shell', 'markdown', 'plaintext', 'cpp', 'c', 'yaml', 'sql', 'dockerfile'
            ];
            languages.forEach(lang => {
                monaco.languages.registerInlineCompletionsProvider(lang, {
                    provideInlineCompletions: async function (model, position, context, token) {
                        if (!state.autocompleteEnabled) return { items: [] };
                        const fullText = model.getValue();
                        const offset = model.getOffsetAt(position);
                        const prefix = fullText.substring(0, offset);
                        const suffix = fullText.substring(offset, offset + 600);

                        if (!prefix || prefix.trim().length === 0) return { items: [] };

                        const statusEl = document.getElementById("editor-status-text");
                        if (statusEl) {
                            statusEl.innerHTML = '<span class="spinner-ring small"></span> AI Completing...';
                        }

                        try {
                            const resp = await fetch("/api/complete", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    prefix: prefix.slice(-2000),
                                    suffix: suffix,
                                    model: state.selectedModel || "",
                                    max_tokens: 48
                                })
                            });

                            if (statusEl && statusEl.innerHTML.includes("Completing")) {
                                statusEl.textContent = "Ready";
                            }

                            if (token && token.isCancellationRequested) {
                                return { items: [] };
                            }

                            const data = await resp.json();
                            if (data.completion && data.completion.trim().length > 0) {
                                if (statusEl) {
                                    statusEl.innerHTML = '<span style="color: #007acc; font-weight: 600;">[Tab] Accept Ghost Text</span>';
                                    setTimeout(() => {
                                        if (statusEl && statusEl.innerHTML.includes("Accept Ghost Text")) {
                                            statusEl.textContent = "Ready";
                                        }
                                    }, 4000);
                                }
                                return {
                                    items: [{
                                        insertText: data.completion,
                                        range: new monaco.Range(
                                            position.lineNumber,
                                            position.column,
                                            position.lineNumber,
                                            position.column
                                        )
                                    }]
                                };
                            }
                        } catch (e) {
                            if (statusEl && statusEl.innerHTML.includes("Completing")) {
                                statusEl.textContent = "Ready";
                            }
                            console.warn("Complete error:", e);
                        }
                        return { items: [] };
                    },
                    freeInlineCompletions: function () {}
                });
            });

            // Restore files open in previous session
            restoreSavedTabs();
        });
    } catch (e) {
        console.error("Monaco error:", e);
        useFallbackEditor();
    }
}

function useFallbackEditor() {
    const container = document.getElementById("monaco-editor");
    container.innerHTML = `<textarea id="fallback-textarea" style="width:100%;height:100%;background:#1e1e1e;color:#cccccc;font-family:monospace;font-size:13px;border:none;padding:10px;outline:none;resize:none;" placeholder="# Lucubrate Editor (Fallback Text Mode)"></textarea>`;
    const ta = document.getElementById("fallback-textarea");
    state.editor = {
        getValue: () => ta.value,
        setValue: (v) => { ta.value = v; },
        setModel: (m) => { ta.value = m?.content || ""; }
    };
    restoreSavedTabs();
}

// Storage for persisted open tabs across sessions
function saveOpenTabsToStorage() {
    try {
        const paths = Object.keys(state.openTabs);
        localStorage.setItem("spark_open_tabs", JSON.stringify(paths));
        if (state.activeTab) {
            localStorage.setItem("spark_active_tab", state.activeTab);
        } else {
            localStorage.removeItem("spark_active_tab");
        }
    } catch (e) {}
}

async function restoreSavedTabs() {
    try {
        const savedJson = localStorage.getItem("spark_open_tabs");
        const savedActive = localStorage.getItem("spark_active_tab");
        if (!savedJson) return;
        const paths = JSON.parse(savedJson);
        if (Array.isArray(paths) && paths.length > 0) {
            for (const p of paths) {
                await openFileInEditor(p, true);
            }
            if (savedActive && state.openTabs[savedActive]) {
                switchActiveTab(savedActive);
            }
        }
    } catch (e) {
        console.warn("Failed restoring saved tabs:", e);
    }
}

// Tab and File Editing
async function openFileInEditor(filePath, silent = false) {
    if (state.openTabs[filePath]) {
        switchActiveTab(filePath);
        return;
    }

    if (state.demoMode) {
        const content = DEMO_CONTENTS[filePath] || ("# " + filePath.split("/").pop() + "\n# Lucubrate Demo File\n");
        const ext = filePath.split('.').pop().toLowerCase();
        const langMap = {
            py: "python", js: "javascript", ts: "typescript", json: "json",
            sh: "shell", bash: "shell", md: "markdown", html: "html",
            css: "css", cpp: "cpp", c: "c", cu: "cpp", h: "cpp", yml: "yaml", yaml: "yaml"
        };
        const lang = langMap[ext] || "plaintext";
        let model = null;
        if (typeof monaco !== "undefined" && monaco.editor?.createModel) {
            model = monaco.editor.createModel(content, lang);
        } else {
            model = { content: content };
        }
        state.openTabs[filePath] = { model: model, dirty: false, originalContent: content };
        createTabUI(filePath);
        switchActiveTab(filePath);
        return;
    }

    try {
        const resp = await fetch("/api/fs/read", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: filePath })
        });
        if (!resp.ok) {
            const err = await resp.text();
            if (!silent) alert("Could not open file: " + err);
            return;
        }
        const data = await resp.json();

        const ext = filePath.split('.').pop().toLowerCase();
        const langMap = {
            py: "python", js: "javascript", ts: "typescript", json: "json",
            sh: "shell", bash: "shell", md: "markdown", html: "html",
            css: "css", cpp: "cpp", c: "c", cu: "cpp", h: "cpp", yml: "yaml", yaml: "yaml"
        };
        const lang = langMap[ext] || "plaintext";

        let model = null;
        if (typeof monaco !== "undefined" && monaco.editor?.createModel) {
            model = monaco.editor.createModel(data.content, lang);
        } else {
            model = { content: data.content };
        }

        state.openTabs[filePath] = {
            model: model,
            dirty: false,
            originalContent: data.content
        };

        createTabUI(filePath);
        switchActiveTab(filePath);
        saveOpenTabsToStorage();
    } catch (e) {
        if (!silent) alert("Could not open file: " + e.message);
    }
}

function createTabUI(filePath) {
    const tabStrip = document.getElementById("tab-strip");
    const fileName = filePath.split("/").pop();

    const tab = document.createElement("div");
    tab.className = "editor-tab";
    tab.id = `tab-${btoa(filePath).replace(/=/g, '')}`;
    tab.innerHTML = `
        <span class="tab-title">${fileName}</span>
        <span class="tab-dirty-indicator">*</span>
        <span class="tab-close" onclick="closeTab('${filePath}', event)">×</span>
    `;
    tab.onclick = () => switchActiveTab(filePath);
    tabStrip.appendChild(tab);
}

function updateTabUI(filePath) {
    const tabEl = document.getElementById(`tab-${btoa(filePath).replace(/=/g, '')}`);
    if (tabEl) {
        if (state.openTabs[filePath]?.dirty) {
            tabEl.classList.add("dirty");
        } else {
            tabEl.classList.remove("dirty");
        }
    }
}

function switchActiveTab(filePath) {
    state.activeTab = filePath;
    document.querySelectorAll(".editor-tab").forEach(t => t.classList.remove("active"));
    const tabEl = document.getElementById(`tab-${btoa(filePath).replace(/=/g, '')}`);
    if (tabEl) tabEl.classList.add("active");

    const tabData = state.openTabs[filePath];
    if (tabData && state.editor) {
        if (typeof state.editor.setModel === "function") {
            state.editor.setModel(tabData.model);
        } else if (typeof state.editor.setValue === "function") {
            state.editor.setValue(tabData.originalContent);
        }
    }

    // Highlight row in tree
    document.querySelectorAll(".tree-node-row").forEach(r => r.classList.remove("active"));
    const activeRow = document.getElementById(`tree-row-${btoa(filePath).replace(/=/g, '')}`);
    if (activeRow) activeRow.classList.add("active");

    saveOpenTabsToStorage();
}

function closeTab(filePath, event) {
    if (event) event.stopPropagation();
    const tabData = state.openTabs[filePath];
    if (tabData?.dirty) {
        if (!confirm(`File "${filePath}" has unsaved changes. Close anyway?`)) return;
    }

    if (tabData?.model?.dispose) tabData.model.dispose();
    delete state.openTabs[filePath];

    const tabEl = document.getElementById(`tab-${btoa(filePath).replace(/=/g, '')}`);
    if (tabEl) tabEl.remove();

    const remaining = Object.keys(state.openTabs);
    if (remaining.length > 0) {
        switchActiveTab(remaining[remaining.length - 1]);
    } else {
        state.activeTab = null;
        if (state.editor?.setValue) state.editor.setValue("# All tabs closed.");
    }
    saveOpenTabsToStorage();
}

async function saveActiveFile() {
    if (!state.activeTab || !state.openTabs[state.activeTab]) return;

    const filePath = state.activeTab;
    const content = state.editor.getValue();

    try {
        const resp = await fetch("/api/fs/write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: filePath, content: content })
        });
        if (!resp.ok) throw new Error(await resp.text());

        state.openTabs[filePath].originalContent = content;
        state.openTabs[filePath].dirty = false;
        updateTabUI(filePath);

        const statusEl = document.getElementById("editor-status-text");
        if (statusEl) {
            statusEl.textContent = `Saved ${filePath}`;
            setTimeout(() => statusEl.textContent = "Ready", 2000);
        }
    } catch (e) {
        alert("Failed to save file: " + e.message);
    }
}

function promptNewFile() {
    startInlineCreation(false);
}

// --- Load Models from Spark ---
async function loadModels() {
    if (state.demoMode) {
        setDemoModels();
        return;
    }
    try {
        const resp = await fetch("/api/models");
        const data = await resp.json();
        const select = document.getElementById("model-select");
        select.innerHTML = "";

        if (!data.models || data.models.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "(No model server active)";
            select.appendChild(opt);
            document.getElementById("metric-model").textContent = "None";
            return;
        }

        const savedModel = (localStorage.getItem("lucubrate_selected_model") || localStorage.getItem("spark_selected_model"));
        data.models.forEach(m => {
            const opt = document.createElement("option");
            opt.value = m;
            opt.textContent = m;
            select.appendChild(opt);
        });

        if (savedModel && data.models.includes(savedModel)) {
            select.value = savedModel;
        } else {
            select.value = data.models[0];
        }

        state.selectedModel = select.value;
        localStorage.setItem("spark_selected_model", state.selectedModel);

        select.onchange = () => {
            state.selectedModel = select.value;
            localStorage.setItem("spark_selected_model", state.selectedModel);
            document.getElementById("metric-model").textContent = state.selectedModel;
        };
        document.getElementById("metric-model").textContent = state.selectedModel;
    } catch (e) {
        console.warn("Error loading models", e);
    }
}

// Auto-poll for models every 8 seconds until live
setInterval(() => {
    if (state.demoMode) return;
    if (!state.selectedModel || state.selectedModel === "" || state.selectedModel === "None") {
        loadModels();
    }
}, 8000);

// --- Agent Chat & Autonomous Tool Loop ---
function initAgentChat() {
    const sendBtn = document.getElementById("btn-send-agent");
    const inputArea = document.getElementById("agent-input");

    // Initialize Drag & Drop for Files/Folders from Explorer
    initAgentDragAndDrop();

    const sendMessage = async () => {
        const text = inputArea.value.trim();
        if (!text && (!state.chatContextFiles || state.chatContextFiles.length === 0)) return;

        const currentAttached = [...(state.chatContextFiles || [])];
        state.chatContextFiles = [];
        renderChatContextChips();

        inputArea.value = "";

        appendChatMessage("user", text, currentAttached);
        state.agentHistory.push({ role: "user", content: text });

        const assistantMsgEl = appendChatMessage("assistant", "");
        const bodyEl = assistantMsgEl.querySelector(".chat-body");

        // Show thinking indicators (header badge, message bubble spinner, send button spinner)
        const thinkingBadge = document.getElementById("chat-thinking-badge");
        if (thinkingBadge) thinkingBadge.style.display = "inline-flex";
        sendBtn.disabled = true;
        sendBtn.innerHTML = '<span class="spinner-ring small"></span> Thinking...';

        bodyEl.innerHTML = `
            <div class="chat-thinking-placeholder" id="chat-thinking-placeholder">
                <span class="spinner-ring"></span>
                <span>Thinking...</span>
            </div>
        `;

        const removeThinkingPlaceholder = () => {
            const ph = bodyEl.querySelector("#chat-thinking-placeholder");
            if (ph) ph.remove();
        };

        let currentThinkingStreamEl = null;
        let currentThinkingDetailsEl = null;
        let thinkingStreamActive = false;
        let thinkingStartTime = Date.now();
        let reasoningText = "";

        const getOrCreateThinkingStream = () => {
            removeThinkingPlaceholder();
            if (!currentThinkingStreamEl) {
                thinkingStreamActive = true;
                thinkingStartTime = Date.now();
                currentThinkingStreamEl = document.createElement("div");
                currentThinkingStreamEl.className = "chat-thinking-stream";
                currentThinkingStreamEl.innerHTML = `
                    <span class="thinking-spinner"></span>
                    <span class="thinking-label">Thinking</span>
                    <span class="thinking-ticker">Connecting thoughts...</span>
                    <span class="thinking-chevron"></span>
                `;
                currentThinkingDetailsEl = document.createElement("div");
                currentThinkingDetailsEl.className = "chat-thinking-details";

                currentThinkingStreamEl.onclick = () => {
                    if (currentThinkingDetailsEl && currentThinkingStreamEl.classList.contains("completed")) {
                        currentThinkingDetailsEl.classList.toggle("open");
                        const chevron = currentThinkingStreamEl.querySelector(".thinking-chevron");
                        if (chevron) {
                            chevron.textContent = currentThinkingDetailsEl.classList.contains("open") ? "▼" : "▶";
                        }
                    }
                };

                bodyEl.appendChild(currentThinkingStreamEl);
                bodyEl.appendChild(currentThinkingDetailsEl);
            }
            return {
                streamEl: currentThinkingStreamEl,
                tickerEl: currentThinkingStreamEl.querySelector(".thinking-ticker"),
                detailsEl: currentThinkingDetailsEl
            };
        };

        const finishThinkingStream = () => {
            if (thinkingStreamActive && currentThinkingStreamEl) {
                thinkingStreamActive = false;
                const elapsedSec = Math.max(1, Math.round((Date.now() - thinkingStartTime) / 1000));
                currentThinkingStreamEl.classList.add("completed");
                const spinner = currentThinkingStreamEl.querySelector(".thinking-spinner");
                if (spinner) spinner.style.display = "none";
                const label = currentThinkingStreamEl.querySelector(".thinking-label");
                if (label) label.textContent = `Thought for ${elapsedSec}s`;
                const ticker = currentThinkingStreamEl.querySelector(".thinking-ticker");
                if (ticker) ticker.textContent = "";
                const chevron = currentThinkingStreamEl.querySelector(".thinking-chevron");
                if (chevron) chevron.textContent = "▶";
            }
        };

        const finishThinkingUI = () => {
            finishThinkingStream();
            removeThinkingPlaceholder();
            if (thinkingBadge) thinkingBadge.style.display = "none";
            sendBtn.disabled = false;
            sendBtn.textContent = "Send Instruction";
        };

        let activeContent = null;
        if (state.activeTab && state.openTabs[state.activeTab] && state.editor) {
            activeContent = state.editor.getValue();
        }

        // Fetch contents/listings for attached context files
        const attachedPayload = [];
        for (const item of currentAttached) {
            try {
                if (item.is_dir) {
                    const r = await fetch(`/api/fs/list?path=${encodeURIComponent(item.path)}`);
                    const d = await r.json();
                    const listing = (d.items || []).map(i => `${i.is_dir ? '[DIR] ' : '[FILE] '}${i.name}`).join("\n");
                    attachedPayload.push({
                        path: item.path,
                        name: item.name,
                        is_dir: true,
                        content: listing
                    });
                } else {
                    const r = await fetch("/api/fs/read", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ path: item.path })
                    });
                    const d = await r.json();
                    attachedPayload.push({
                        path: item.path,
                        name: item.name,
                        is_dir: false,
                        content: d.content
                    });
                }
            } catch (e) {
                attachedPayload.push({
                    path: item.path,
                    name: item.name,
                    is_dir: item.is_dir,
                    content: null
                });
            }
        }

        try {
            const resp = await fetch("/api/agent/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: state.agentHistory,
                    model: state.selectedModel,
                    active_file: state.activeTab,
                    active_content: activeContent,
                    attached_files: attachedPayload
                })
            });

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();

            let currentTextSegment = null;
            let currentSegmentRaw = "";
            let fullAssistantReply = "";
            let sseBuffer = "";

            const getOrCreateTextSegment = () => {
                removeThinkingPlaceholder();
                if (!currentTextSegment) {
                    currentTextSegment = document.createElement("div");
                    currentTextSegment.className = "chat-text-segment";
                    bodyEl.appendChild(currentTextSegment);
                    currentSegmentRaw = "";
                }
                return currentTextSegment;
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                sseBuffer += decoder.decode(value, { stream: true });
                const lines = sseBuffer.split("\n");
                sseBuffer = lines.pop();

                for (const line of lines) {
                    if (line.startsWith("data: ")) {
                        try {
                            const data = JSON.parse(line.substring(6));
                            if (data.type === "reasoning") {
                                removeThinkingPlaceholder();
                                reasoningText += data.content;
                                const { tickerEl, detailsEl } = getOrCreateThinkingStream();
                                detailsEl.textContent = reasoningText;

                                // Dynamically show current reasoning sentence in auto-scrolling single line
                                const thoughtLines = reasoningText.trim().split(/[\r\n.]+/);
                                const latestThought = thoughtLines[thoughtLines.length - 1]?.trim() || "";
                                if (tickerEl && latestThought) {
                                    tickerEl.textContent = `"${latestThought.slice(-65)}"`;
                                }
                                scrollAgentChatToBottom(false);
                            } else if (data.type === "token") {
                                finishThinkingStream();
                                removeThinkingPlaceholder();
                                fullAssistantReply += data.content;
                                currentSegmentRaw += data.content;
                                const seg = getOrCreateTextSegment();
                                seg.innerHTML = formatMarkdown(currentSegmentRaw);
                                scrollAgentChatToBottom(false);
                            } else if (data.type === "tool_start") {
                                finishThinkingStream();
                                removeThinkingPlaceholder();
                                // Close current text segment so subsequent output starts below tool card
                                currentTextSegment = null;
                                currentSegmentRaw = "";

                                const toolDiv = document.createElement("div");
                                toolDiv.className = "tool-execution-card";
                                toolDiv.innerHTML = `<div class="tool-execution-title">[TOOL CALL] ${data.tool}</div><pre>${JSON.stringify(data.args, null, 2)}</pre>`;
                                bodyEl.appendChild(toolDiv);
                                scrollAgentChatToBottom(true);
                            } else if (data.type === "tool_end") {
                                finishThinkingStream();
                                currentTextSegment = null;
                                currentSegmentRaw = "";

                                const resDiv = document.createElement("div");
                                resDiv.className = "tool-execution-card";
                                resDiv.style.borderLeftColor = "#28a745";
                                resDiv.innerHTML = `<div class="tool-execution-title" style="color:#28a745">[TOOL RESULT] ${data.tool}:</div><pre>${data.result}</pre>`;
                                bodyEl.appendChild(resDiv);
                                scrollAgentChatToBottom(true);

                                if ((data.tool === "write_file" || data.tool === "edit_file") && data.args?.path === state.activeTab) {
                                    openFileInEditor(state.activeTab);
                                }
                            } else if (data.type === "error") {
                                finishThinkingStream();
                                removeThinkingPlaceholder();
                                currentTextSegment = null;
                                const errDiv = document.createElement("div");
                                errDiv.style.color = "#f97583";
                                errDiv.textContent = data.content;
                                bodyEl.appendChild(errDiv);
                                scrollAgentChatToBottom(true);
                            }
                        } catch (e) {}
                    }
                }
            }

            state.agentHistory.push({ role: "assistant", content: fullAssistantReply });
            scrollAgentChatToBottom(true);
        } catch (e) {
            removeThinkingPlaceholder();
            const errDiv = document.createElement("div");
            errDiv.style.color = "#f97583";
            errDiv.textContent = `Error communicating with LLM host: ${e.message}`;
            bodyEl.appendChild(errDiv);
            scrollAgentChatToBottom(true);
        } finally {
            finishThinkingUI();
        }
    };

    sendBtn.onclick = sendMessage;
    inputArea.onkeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };
}

function initAgentDragAndDrop() {
    const agentPanel = document.getElementById("panel-agent");
    const inputContainer = document.getElementById("agent-input-container");
    const inputArea = document.getElementById("agent-input");
    const dropTargets = [agentPanel, inputContainer, inputArea];

    const handleDragOver = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (agentPanel) agentPanel.classList.add("drag-over");
        if (inputContainer) inputContainer.classList.add("drag-over");
    };

    const handleDragLeave = (e) => {
        if (agentPanel && !agentPanel.contains(e.relatedTarget)) {
            agentPanel.classList.remove("drag-over");
        }
        if (inputContainer && !inputContainer.contains(e.relatedTarget)) {
            inputContainer.classList.remove("drag-over");
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        if (agentPanel) agentPanel.classList.remove("drag-over");
        if (inputContainer) inputContainer.classList.remove("drag-over");

        let nodeData = null;
        try {
            const rawJson = e.dataTransfer.getData("application/json");
            if (rawJson) nodeData = JSON.parse(rawJson);
        } catch (err) {}

        if (!nodeData) {
            const rawPath = e.dataTransfer.getData("text/plain");
            if (rawPath) {
                const name = rawPath.split("/").pop();
                nodeData = { path: rawPath, name: name, is_dir: state.treeData[rawPath]?.is_dir || false };
            }
        }

        if (nodeData && nodeData.path) {
            addChatContextFile(nodeData);
        }
    };

    dropTargets.forEach(el => {
        if (el) {
            el.addEventListener("dragover", handleDragOver);
            el.addEventListener("dragleave", handleDragLeave);
            el.addEventListener("drop", handleDrop);
        }
    });
}

function addChatContextFile(node) {
    if (!state.chatContextFiles) state.chatContextFiles = [];
    if (state.chatContextFiles.some(f => f.path === node.path)) {
        return;
    }
    state.chatContextFiles.push(node);
    renderChatContextChips();

    const input = document.getElementById("agent-input");
    if (input) {
        const mention = `@${node.name} `;
        if (!input.value.includes(`@${node.name}`)) {
            const pos = input.selectionStart || input.value.length;
            input.value = input.value.slice(0, pos) + mention + input.value.slice(pos);
        }
        input.focus();
    }
}

function removeChatContextFile(path) {
    if (!state.chatContextFiles) return;
    state.chatContextFiles = state.chatContextFiles.filter(f => f.path !== path);
    renderChatContextChips();
}

function renderChatContextChips() {
    const container = document.getElementById("agent-context-chips");
    if (!container) return;
    container.innerHTML = "";
    if (!state.chatContextFiles || state.chatContextFiles.length === 0) return;

    state.chatContextFiles.forEach(item => {
        const chip = document.createElement("div");
        chip.className = "context-chip";
        chip.title = item.path;
        chip.innerHTML = `
            <span class="chip-icon">${item.is_dir ? '📁' : '📄'}</span>
            <span class="chip-label">${item.name}</span>
            <span class="chip-remove" title="Remove attachment">×</span>
        `;
        chip.querySelector(".chip-remove").onclick = (e) => {
            e.stopPropagation();
            removeChatContextFile(item.path);
        };
        container.appendChild(chip);
    });
}

function scrollAgentChatToBottom(force = true) {
    const historyEl = document.getElementById("agent-history");
    if (!historyEl) return;
    if (!force) {
        const distance = historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight;
        if (distance > 150) return;
    }
    historyEl.scrollTop = historyEl.scrollHeight;
    requestAnimationFrame(() => {
        if (historyEl) historyEl.scrollTop = historyEl.scrollHeight;
    });
}

function appendChatMessage(role, content, attachedFiles = []) {
    const historyEl = document.getElementById("agent-history");
    const msg = document.createElement("div");
    msg.className = `chat-message ${role}`;

    let pillsHtml = "";
    if (attachedFiles && attachedFiles.length > 0) {
        pillsHtml = `<div class="chat-attached-pills">` + attachedFiles.map(f => `
            <span class="context-chip small" title="${f.path}">
                <span class="chip-icon">${f.is_dir ? '📁' : '📄'}</span>
                <span class="chip-label">${f.name}</span>
            </span>
        `).join("") + `</div>`;
    }

    msg.innerHTML = `
        <div class="chat-header">
            <span>${role === "user" ? "You (Client)" : "Lucubrate Agent (" + state.selectedModel + ")"}</span>
            <span style="font-size:10px; color:#858585">${new Date().toLocaleTimeString()}</span>
        </div>
        <div class="chat-body">${pillsHtml}${formatMarkdown(content)}</div>
    `;
    historyEl.appendChild(msg);
    scrollAgentChatToBottom(true);
    return msg;
}

function highlightCode(code, lang) {
    if (!code) return "";
    const l = (lang || "").toLowerCase();

    // Helper token storage to prevent nested regex interference
    const tokens = [];
    const saveToken = (html) => {
        const id = `\x00TK_${tokens.length}\x00`;
        tokens.push(html);
        return id;
    };

    let text = code;

    if (l === "python" || l === "py") {
        // Strings (triple quoted then single/double, including f/r prefixes)
        text = text.replace(/("""[\s\S]*?"""|'''[\s\S]*?''')/g, (m) => saveToken(`<span class="syn-str">${m}</span>`));
        text = text.replace(/(f?r?"(?:\\.|[^"\\])*"|f?r?'(?:\\.|[^'\\])*')/g, (m) => saveToken(`<span class="syn-str">${m}</span>`));

        // Comments
        text = text.replace(/(#.*)$/gm, (m) => saveToken(`<span class="syn-comment">${m}</span>`));

        // Decorators
        text = text.replace(/(@[a-zA-Z0-9_\.]+)/g, (m) => saveToken(`<span class="syn-func">${m}</span>`));

        // Function and Class definitions
        text = text.replace(/\b(def)\s+([a-zA-Z0-9_]+)\b/g, (m, d, f) => `<span class="syn-keyword">${d}</span> <span class="syn-func">${f}</span>`);
        text = text.replace(/\b(class)\s+([a-zA-Z0-9_]+)\b/g, (m, c, cl) => `<span class="syn-keyword">${c}</span> <span class="syn-class">${cl}</span>`);

        // Control flow & keywords
        text = text.replace(/\b(return|if|elif|else|while|for|in|try|except|finally|with|as|lambda|yield|raise|break|continue|pass|assert|and|or|not|is)\b/g, '<span class="syn-control">$1</span>');
        text = text.replace(/\b(import|from|global|nonlocal|async|await|True|False|None)\b/g, '<span class="syn-keyword">$1</span>');

        // Builtins & common types
        text = text.replace(/\b(self|cls|super|print|len|range|enumerate|zip|isinstance|issubclass|type|str|int|float|bool|list|dict|set|tuple)\b/g, '<span class="syn-builtin">$1</span>');

        // Numbers
        text = text.replace(/\b([0-9]+\.?[0-9]*)\b/g, '<span class="syn-num">$1</span>');
    } else if (l === "json") {
        text = text.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"(\s*:)?/g, (m, val, isKey) => {
            if (isKey) return saveToken(`<span class="syn-func">"${val}"</span>:`);
            return saveToken(`<span class="syn-str">"${val}"</span>`);
        });
        text = text.replace(/\b(true|false|null)\b/g, '<span class="syn-keyword">$1</span>');
        text = text.replace(/\b(-?[0-9]+\.?[0-9]*)\b/g, '<span class="syn-num">$1</span>');
    } else if (l === "bash" || l === "sh" || l === "shell") {
        text = text.replace(/(#.*)$/gm, (m) => saveToken(`<span class="syn-comment">${m}</span>`));
        text = text.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, (m) => saveToken(`<span class="syn-str">${m}</span>`));
        text = text.replace(/(\$[a-zA-Z0-9_]+|\$\{[a-zA-Z0-9_]+\})/g, '<span class="syn-builtin">$1</span>');
        text = text.replace(/\b(--?[a-zA-Z0-9_\-]+)\b/g, '<span class="syn-class">$1</span>');
        text = text.replace(/\b(if|then|else|elif|fi|for|in|do|done|while|case|esac|return|exit)\b/g, '<span class="syn-control">$1</span>');
        text = text.replace(/\b(echo|cd|ls|mkdir|rm|cp|mv|cat|grep|sed|awk|export|source|python|python3|pip|git|curl|wget)\b/g, '<span class="syn-func">$1</span>');
    } else {
        // Generic JS / TS / C / CPP fallback
        text = text.replace(/(\/\*[\s\S]*?\*\/|\/\/.*$)/gm, (m) => saveToken(`<span class="syn-comment">${m}</span>`));
        text = text.replace(/(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, (m) => saveToken(`<span class="syn-str">${m}</span>`));
        text = text.replace(/\b(function|class|const|let|var|import|export|from|default|new|this|async|await)\b/g, '<span class="syn-keyword">$1</span>');
        text = text.replace(/\b(return|if|else|switch|case|break|continue|for|while|try|catch|finally|throw)\b/g, '<span class="syn-control">$1</span>');
        text = text.replace(/\b(true|false|null|undefined|NaN)\b/g, '<span class="syn-keyword">$1</span>');
        text = text.replace(/\b([0-9]+\.?[0-9]*)\b/g, '<span class="syn-num">$1</span>');
    }

    tokens.forEach((tk, idx) => {
        text = text.replace(`\x00TK_${idx}\x00`, tk);
    });

    return text;
}

function formatMarkdown(text) {
    if (!text) return "";
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const codeBlocks = [];

    // 1. Complete fenced code blocks
    html = html.replace(/```([a-zA-Z0-9_\-\+]*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const placeholder = `\x00CB_${codeBlocks.length}\x00`;
        const langClean = (lang || 'python').toLowerCase();
        const highlighted = highlightCode(code.trim(), langClean);
        codeBlocks.push(`
            <div class="code-block-wrapper">
                <div class="code-block-header">
                    <span class="code-lang">${langClean}</span>
                    <button class="btn-copy-code" onclick="copyCodeSnippet(this)" title="Copy code snippet">Copy</button>
                </div>
                <pre><code class="lang-${langClean}">${highlighted}</code></pre>
            </div>
        `);
        return placeholder;
    });

    // 2. Unclosed code block during active streaming
    if (html.includes("```")) {
        html = html.replace(/```([a-zA-Z0-9_\-\+]*)\n?([\s\S]*)$/, (match, lang, code) => {
            const placeholder = `\x00CB_${codeBlocks.length}\x00`;
            const langClean = (lang || 'python').toLowerCase();
            const highlighted = highlightCode(code, langClean);
            codeBlocks.push(`
                <div class="code-block-wrapper">
                    <div class="code-block-header">
                        <span class="code-lang">${langClean}</span>
                        <button class="btn-copy-code" onclick="copyCodeSnippet(this)" title="Copy code snippet">Copy</button>
                    </div>
                    <pre><code class="lang-${langClean}">${highlighted}</code></pre>
                </div>
            `);
            return placeholder;
        });
    }

    // 3. Inline code
    html = html.replace(/`([^`\n]+)`/g, (match, code) => {
        const placeholder = `\x00IC_${codeBlocks.length}\x00`;
        codeBlocks.push(`<code class="inline-code">${code}</code>`);
        return placeholder;
    });

    // 4. Block-level headers
    html = html.replace(/^### (.*)$/gm, '<h5 class="chat-h5">$1</h5>');
    html = html.replace(/^## (.*)$/gm, '<h4 class="chat-h4">$1</h4>');
    html = html.replace(/^# (.*)$/gm, '<h3 class="chat-h3">$1</h3>');

    // 5. Horizontal rules
    html = html.replace(/^(\-{3,}|\*{3,})$/gm, '<hr class="chat-hr">');

    // 6. Blockquotes
    html = html.replace(/^&gt; (.*)$/gm, '<blockquote class="chat-quote">$1</blockquote>');

    // 7. Bullet / numbered lists
    html = html.replace(/^[*\-] (.*)$/gm, '<div class="chat-bullet-item"><span class="bullet-dot">•</span><span>$1</span></div>');
    html = html.replace(/^([0-9]+)\. (.*)$/gm, '<div class="chat-num-item"><span class="num-label">$1.</span><span>$2</span></div>');

    // 8. Inline formatting: Bold & Italic
    html = html.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    html = html.replace(/_([^_\n]+)_/g, '<em>$1</em>');

    // 9. Preserve newlines outside block elements
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/(<\/(h[1-6]|blockquote|pre|div|hr)>)<br>/g, '$1');
    html = html.replace(/<br>(<(h[1-6]|blockquote|pre|div|hr))/g, '$1');

    // 10. Restore code tokens
    codeBlocks.forEach((codeHtml, idx) => {
        html = html.replace(`\x00CB_${idx}\x00`, codeHtml);
        html = html.replace(`\x00IC_${idx}\x00`, codeHtml);
    });

    return html;
}

function copyCodeSnippet(btn) {
    const wrapper = btn.closest(".code-block-wrapper");
    if (!wrapper) return;
    const codeEl = wrapper.querySelector("code");
    if (!codeEl) return;
    const text = codeEl.innerText || codeEl.textContent;
    navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("copied");
        }, 2000);
    }).catch(err => {
        console.warn("Copy snippet failed:", err);
    });
}

function initColumnResizers() {
    // 1. Right Column (Agent Chat) Resizer
    const resizerRight = document.getElementById("resizer-right");
    const panelAgent = document.getElementById("panel-agent");

    // Restore saved width from localStorage if present
    const savedRightWidth = localStorage.getItem("spark_column_right_width");
    if (savedRightWidth && panelAgent) {
        panelAgent.style.width = `${savedRightWidth}px`;
    }

    if (resizerRight && panelAgent) {
        let isDraggingRight = false;
        let startX = 0;
        let startWidth = 0;

        resizerRight.addEventListener("mousedown", (e) => {
            isDraggingRight = true;
            startX = e.clientX;
            startWidth = panelAgent.offsetWidth;
            resizerRight.classList.add("dragging");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        });

        window.addEventListener("mousemove", (e) => {
            if (!isDraggingRight) return;
            const deltaX = startX - e.clientX;
            const newWidth = Math.max(260, Math.min(window.innerWidth * 0.75, startWidth + deltaX));
            panelAgent.style.width = `${newWidth}px`;
            if (state.editor && typeof state.editor.layout === "function") {
                state.editor.layout();
            }
        });

        window.addEventListener("mouseup", () => {
            if (isDraggingRight) {
                isDraggingRight = false;
                resizerRight.classList.remove("dragging");
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                localStorage.setItem("spark_column_right_width", panelAgent.offsetWidth);
                if (state.editor && typeof state.editor.layout === "function") {
                    state.editor.layout();
                }
            }
        });
    }

    // 2. Left Column (File Explorer) Resizer
    const resizerLeft = document.getElementById("resizer-left");
    const panelExplorer = document.getElementById("panel-explorer");

    const savedLeftWidth = localStorage.getItem("spark_column_left_width");
    if (savedLeftWidth && panelExplorer) {
        panelExplorer.style.width = `${savedLeftWidth}px`;
    }

    if (resizerLeft && panelExplorer) {
        let isDraggingLeft = false;
        let startX = 0;
        let startWidth = 0;

        resizerLeft.addEventListener("mousedown", (e) => {
            isDraggingLeft = true;
            startX = e.clientX;
            startWidth = panelExplorer.offsetWidth;
            resizerLeft.classList.add("dragging");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        });

        window.addEventListener("mousemove", (e) => {
            if (!isDraggingLeft) return;
            const deltaX = e.clientX - startX;
            const newWidth = Math.max(160, Math.min(window.innerWidth * 0.5, startWidth + deltaX));
            panelExplorer.style.width = `${newWidth}px`;
            if (state.editor && typeof state.editor.layout === "function") {
                state.editor.layout();
            }
        });

        window.addEventListener("mouseup", () => {
            if (isDraggingLeft) {
                isDraggingLeft = false;
                resizerLeft.classList.remove("dragging");
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                localStorage.setItem("spark_column_left_width", panelExplorer.offsetWidth);
                if (state.editor && typeof state.editor.layout === "function") {
                    state.editor.layout();
                }
            }
        });
    }
}

// --- Multi-Terminal Drawer (xterm.js tabs over independent WebSockets) ---
function initTerminal() {
    if (typeof Terminal === "undefined") {
        console.warn("xterm library not yet loaded");
        return;
    }

    const termContainer = document.getElementById("terminal-container");
    termContainer.addEventListener("click", () => {
        if (state.activeTerminalId && state.terminals[state.activeTerminalId]?.term) {
            state.terminals[state.activeTerminalId].term.focus();
        }
    });

    const drawer = document.getElementById("terminal-drawer");
    drawer.addEventListener("click", (e) => {
        if (!e.target.closest("#btn-toggle-terminal") && !e.target.closest("#terminal-resizer") && !e.target.closest(".terminal-tab") && !e.target.closest(".btn-new-terminal")) {
            if (state.activeTerminalId && state.terminals[state.activeTerminalId]?.term) {
                state.terminals[state.activeTerminalId].term.focus();
            }
        }
    });

    initTerminalResizer();
    window.addEventListener("resize", () => fitTerminal());

    const toggleBtn = document.getElementById("btn-toggle-terminal");
    if (toggleBtn) toggleBtn.onclick = toggleTerminalDrawer;

    // Create initial terminal tab
    createNewTerminalTab();
}

function createNewTerminalTab() {
    state.terminalIdCounter++;
    const termId = `term-${state.terminalIdCounter}`;
    const termName = `${state.terminalIdCounter}: bash`;

    const container = document.getElementById("terminal-container");
    const pane = document.createElement("div");
    pane.id = `pane-${termId}`;
    pane.className = "term-pane";
    container.appendChild(pane);

    const term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'Consolas, Menlo, Monaco, monospace',
        disableStdin: false,
        convertEol: true,
        scrollback: 5000,
        theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#ffffff'
        }
    });

    term.open(pane);

    const termData = {
        id: termId,
        name: termName,
        term: term,
        ws: null,
        pane: pane
    };
    state.terminals[termId] = termData;

    // Send keystrokes over this terminal's websocket
    term.onData((data) => {
        if (state.demoMode) return;
        if (termData.ws && termData.ws.readyState === WebSocket.OPEN) {
            termData.ws.send(data);
        }
    });

    // Connect independent WebSocket shell
    connectTerminalWebSocket(termId);

    // Switch to this new tab
    switchTerminalTab(termId);

    // Uncollapse drawer if collapsed
    const drawer = document.getElementById("terminal-drawer");
    if (drawer && drawer.classList.contains("collapsed")) {
        drawer.classList.remove("collapsed");
    }

    setTimeout(() => {
        fitTerminal(termId);
        term.focus();
    }, 50);

    return termId;
}

function connectTerminalWebSocket(termId) {
    const termData = state.terminals[termId];
    if (!termData) return;
    if (termData.ws && termData.ws.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;
    const ws = new WebSocket(wsUrl);
    termData.ws = ws;

    ws.onopen = () => {
        if (state.demoMode) return;
        termData.term.write(`\x1b[32m[Connected (${termData.name}): ${(state.config.remote_user || state.config.spark_user || "")}@${(state.config.remote_host || state.config.spark_host || "")}]\x1b[0m\r\n\r\n`);
        fitTerminal(termId);
        if (state.activeTerminalId === termId) {
            termData.term.focus();
        }
    };

    ws.onmessage = (event) => {
        if (state.demoMode) return;
        termData.term.write(event.data);
    };

    ws.onclose = () => {
        termData.term.write(`\r\n\x1b[33m[Terminal ${termData.name} Disconnected. Reconnecting in 3s...]\x1b[0m\r\n`);
        setTimeout(() => {
            if (state.terminals[termId]) {
                connectTerminalWebSocket(termId);
            }
        }, 3000);
    };
}

function switchTerminalTab(termId) {
    if (!state.terminals[termId]) return;
    state.activeTerminalId = termId;

    // Show only the active terminal pane
    Object.keys(state.terminals).forEach(id => {
        const item = state.terminals[id];
        if (item.pane) {
            item.pane.style.display = (id === termId) ? "block" : "none";
        }
    });

    renderTerminalTabs();

    setTimeout(() => {
        fitTerminal(termId);
        if (state.terminals[termId]?.term) {
            state.terminals[termId].term.focus();
        }
    }, 20);
}

function closeTerminalTab(termId, event) {
    if (event) {
        event.stopPropagation();
    }
    const ids = Object.keys(state.terminals);
    if (ids.length <= 1) {
        return;
    }

    const termData = state.terminals[termId];
    if (!termData) return;

    if (termData.ws) {
        termData.ws.close();
    }
    if (termData.term) {
        termData.term.dispose();
    }
    if (termData.pane && termData.pane.parentNode) {
        termData.pane.parentNode.removeChild(termData.pane);
    }
    delete state.terminals[termId];

    if (state.activeTerminalId === termId) {
        const remaining = Object.keys(state.terminals);
        switchTerminalTab(remaining[remaining.length - 1]);
    } else {
        renderTerminalTabs();
    }
}

function renderTerminalTabs() {
    const tabsBar = document.getElementById("terminal-tabs-bar");
    if (!tabsBar) return;
    tabsBar.innerHTML = "";

    const ids = Object.keys(state.terminals);
    ids.forEach(id => {
        const item = state.terminals[id];
        const tab = document.createElement("div");
        tab.className = "terminal-tab" + (id === state.activeTerminalId ? " active" : "");
        tab.onclick = () => switchTerminalTab(id);

        const titleSpan = document.createElement("span");
        titleSpan.textContent = item.name;
        tab.appendChild(titleSpan);

        if (ids.length > 1) {
            const closeBtn = document.createElement("span");
            closeBtn.className = "terminal-tab-close";
            closeBtn.innerHTML = "×";
            closeBtn.title = "Close Terminal";
            closeBtn.onclick = (e) => closeTerminalTab(id, e);
            tab.appendChild(closeBtn);
        }

        tabsBar.appendChild(tab);
    });
}

function initTerminalResizer() {
    const resizer = document.getElementById("terminal-resizer");
    const drawer = document.getElementById("terminal-drawer");
    if (!resizer || !drawer) return;

    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    resizer.addEventListener("mousedown", (e) => {
        isDragging = true;
        startY = e.clientY;
        startHeight = drawer.offsetHeight;
        document.body.style.cursor = "ns-resize";
        e.preventDefault();
        e.stopPropagation();
    });

    window.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        const delta = (startY - e.clientY) / (currentZoom || 1.0);
        const newHeight = Math.min(Math.max(startHeight + delta, 60), (window.innerHeight / (currentZoom || 1.0)) * 0.8);
        drawer.style.height = `${newHeight}px`;
        fitTerminal();
    });

    window.addEventListener("mouseup", () => {
        if (isDragging) {
            isDragging = false;
            document.body.style.cursor = "default";
            fitTerminal();
        }
    });
}

function fitTerminal(termId = state.activeTerminalId) {
    if (!termId || !state.terminals[termId]) return;
    const termData = state.terminals[termId];
    const container = document.getElementById("terminal-container");
    if (!container || container.clientHeight === 0 || container.clientWidth === 0) return;
    
    // Accurate cell measurement
    let cellWidth = 7.3;
    let cellHeight = 16.5;
    try {
        const renderService = termData.term._core?._renderService;
        if (renderService?.dimensions?.css?.cell?.height > 0) {
            cellHeight = renderService.dimensions.css.cell.height;
            cellWidth = renderService.dimensions.css.cell.width;
        } else {
            const rowElem = termData.pane.querySelector(".xterm-rows > div");
            if (rowElem && rowElem.clientHeight > 0) {
                cellHeight = rowElem.clientHeight;
                cellWidth = rowElem.clientWidth / Math.max(termData.term.cols || 80, 1);
            }
        }
    } catch (e) {}

    // Subtract explicit buffer for scrollbar and padding so bottom prompt row is NEVER clipped
    const availableWidth = Math.max(container.clientWidth - 16, 80);
    const availableHeight = Math.max(container.clientHeight - 8, 30);

    const cols = Math.max(25, Math.floor(availableWidth / cellWidth));
    const rows = Math.max(3, Math.floor(availableHeight / cellHeight));
    
    termData.term.resize(cols, rows);
    termData.term.scrollToBottom();

    if (termData.ws && termData.ws.readyState === WebSocket.OPEN) {
        termData.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
}

function toggleTerminalDrawer() {
    const drawer = document.getElementById("terminal-drawer");
    drawer.classList.toggle("collapsed");
    if (!drawer.classList.contains("collapsed")) {
        setTimeout(() => {
            fitTerminal();
            if (state.activeTerminalId && state.terminals[state.activeTerminalId]?.term) {
                state.terminals[state.activeTerminalId].term.focus();
            }
        }, 50);
    }
}

// --- Autocomplete Toggle Controller ---
function updateAutocompleteUI() {
    const btn = document.getElementById("btn-toggle-autocomplete");
    const text = document.getElementById("autocomplete-status-text");
    if (!btn || !text) return;
    if (state.autocompleteEnabled) {
        btn.classList.add("on");
        btn.classList.remove("off");
        text.textContent = "ON";
    } else {
        btn.classList.add("off");
        btn.classList.remove("on");
        text.textContent = "OFF";
    }
}

function toggleAutocomplete() {
    state.autocompleteEnabled = !state.autocompleteEnabled;
    localStorage.setItem("spark_autocomplete_enabled", state.autocompleteEnabled ? "true" : "false");
    updateAutocompleteUI();
}

function toggleExplorerPanel() {
    const p = document.getElementById("panel-explorer");
    p.style.display = p.style.display === "none" ? "flex" : "none";
}

function toggleAgentPanel() {
    const p = document.getElementById("panel-agent");
    p.style.display = p.style.display === "none" ? "flex" : "none";
}

function triggerAICompletion() {
    if (state.editor && typeof state.editor.trigger === "function") {
        state.editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {});
    }
}

function formatActiveBuffer() {
    if (state.editor && typeof state.editor.getAction === "function") {
        state.editor.getAction('editor.action.formatDocument')?.run();
    }
}

// --- Search Bar Filter ---
function initSearchBar() {
    const search = document.getElementById("nav-search-input");
    search.addEventListener("input", (e) => {
        const query = e.target.value.toLowerCase();
        document.querySelectorAll(".tree-node-row").forEach(item => {
            const name = item.textContent.toLowerCase();
            item.style.display = name.includes(query) ? "flex" : "none";
        });
    });
}

// --- Global UI Zoom Management (VS Code Style Ctrl+MouseWheel & Ctrl+=/-) ---
let currentZoom = parseFloat(localStorage.getItem("spark_zoom_level") || "1.0");

function applyZoom(zoom) {
    currentZoom = Math.min(Math.max(zoom, 0.6), 2.2);
    document.body.style.zoom = currentZoom;
    
    // Dynamically adjust body bounds so zoomed UI fits physical viewport exactly
    document.body.style.height = `${window.innerHeight / currentZoom}px`;
    document.body.style.width = `${window.innerWidth / currentZoom}px`;
    localStorage.setItem("spark_zoom_level", currentZoom.toFixed(2));

    // Allow layouts to settle after scaling
    setTimeout(() => {
        if (state.editor && typeof state.editor.layout === "function") {
            state.editor.layout();
        }
        if (typeof fitTerminal === "function") {
            fitTerminal();
        }
    }, 25);
}

function zoomIn() {
    applyZoom(currentZoom + 0.1);
}

function zoomOut() {
    applyZoom(currentZoom - 0.1);
}

function resetZoom() {
    applyZoom(1.0);
}

function initZoom() {
    // 1. Restore persisted zoom preference
    applyZoom(currentZoom);

    // 2. Adjust on physical window resize
    window.addEventListener("resize", () => {
        applyZoom(currentZoom);
    });

    // 3. Capture Ctrl + MouseWheel globally before Monaco or panels swallow it
    window.addEventListener("wheel", (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            const delta = e.deltaY < 0 ? 0.05 : -0.05;
            applyZoom(currentZoom + delta);
        }
    }, { passive: false, capture: true });
}

// --- Keyboard Shortcuts ---
function initKeyboardShortcuts() {
    window.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "D" || e.key === "d")) {
            e.preventDefault();
            toggleDemoMode();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === ",") {
            e.preventDefault();
            openSettingsModal();
        } else if ((e.ctrlKey || e.metaKey) && e.key === "`") {
            e.preventDefault();
            toggleTerminalDrawer();
        } else if ((e.ctrlKey || e.metaKey) && e.key === "w" && state.activeTab) {
            e.preventDefault();
            closeTab(state.activeTab);
        } else if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
            e.preventDefault();
            zoomIn();
        } else if ((e.ctrlKey || e.metaKey) && (e.key === "-" || e.key === "_")) {
            e.preventDefault();
            zoomOut();
        } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
            e.preventDefault();
            resetZoom();
        } else if (e.key === "Delete" || e.key === "Del") {
            const activeEl = document.activeElement;
            const isTyping = activeEl && (
                activeEl.tagName === "INPUT" || 
                activeEl.tagName === "TEXTAREA" || 
                activeEl.isContentEditable || 
                activeEl.closest(".monaco-editor") || 
                activeEl.closest(".terminal-drawer")
            );
            if (!isTyping && state.selectedNode && state.selectedNode.path !== state.currentPath) {
                e.preventDefault();
                deleteSelectedItem(state.selectedNode);
            }
        } else if (e.key === "F2") {
            const activeEl = document.activeElement;
            const isTyping = activeEl && (
                activeEl.tagName === "INPUT" || 
                activeEl.tagName === "TEXTAREA" || 
                activeEl.isContentEditable || 
                activeEl.closest(".monaco-editor") || 
                activeEl.closest(".terminal-drawer")
            );
            if (!isTyping && state.selectedNode && state.selectedNode.path !== state.currentPath) {
                e.preventDefault();
                startInlineRename(state.selectedNode);
            }
        }
    });
}

// --- Settings Modal Logic ---
async function openSettingsModal() {
    try {
        const resp = await fetch("/api/config");
        if (resp.ok) state.config = await resp.json();
    } catch (e) {}

    document.getElementById("setting-host").value = state.config.remote_host || state.config.spark_host || "";
    document.getElementById("setting-user").value = state.config.remote_user || state.config.spark_user || "";
    document.getElementById("setting-port").value = state.config.remote_port || state.config.spark_port || 22;
    document.getElementById("setting-key").value = state.config.remote_key_path || state.config.spark_key_path || "";
    document.getElementById("setting-model-url").value = state.config.model_url || "";
    document.getElementById("setting-root").value = state.config.remote_root || "";
    document.getElementById("setting-test-result").innerHTML = "";

    document.getElementById("settings-modal-backdrop").style.display = "flex";
}

function closeSettingsModal() {
    document.getElementById("settings-modal-backdrop").style.display = "none";
}

async function testConnectionFromSettings() {
    const resultEl = document.getElementById("setting-test-result");
    resultEl.innerHTML = `<span style="color:#888888">Testing SSH & Model endpoint...</span>`;

    const payload = {
        remote_host: document.getElementById("setting-host").value.trim(),
        remote_user: document.getElementById("setting-user").value.trim(),
        remote_port: parseInt(document.getElementById("setting-port").value) || 22,
        remote_key_path: document.getElementById("setting-key").value.trim(),
        remote_host: document.getElementById("setting-host").value.trim(),
        remote_user: document.getElementById("setting-user").value.trim(),
        remote_port: parseInt(document.getElementById("setting-port").value) || 22,
        remote_key_path: document.getElementById("setting-key").value.trim(),
        spark_host: document.getElementById("setting-host").value.trim(),
        spark_user: document.getElementById("setting-user").value.trim(),
        spark_port: parseInt(document.getElementById("setting-port").value) || 22,
        spark_key_path: document.getElementById("setting-key").value.trim(),
        model_url: document.getElementById("setting-model-url").value.trim(),
        remote_root: document.getElementById("setting-root").value.trim()
    };

    try {
        const resp = await fetch("/api/config/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const res = await resp.json();
        let out = "";
        if (res.ssh) {
            out += `<span style="color:#4ec9b0">✓ SSH Connected successfully (${res.hostname})</span><br>`;
        } else {
            out += `<span style="color:#f97583">✗ SSH Failed: ${res.error}</span><br>`;
        }

        if (res.models) {
            out += `<span style="color:#4ec9b0">✓ Model server reachable at ${payload.model_url}</span>`;
        } else {
            out += `<span style="color:#f97583">✗ Model server: ${res.model_error || 'Offline / warming up'}</span>`;
        }
        resultEl.innerHTML = out;
    } catch (e) {
        resultEl.innerHTML = `<span style="color:#f97583">Test failed: ${e.message}</span>`;
    }
}

async function saveSettings() {
    const payload = {
        remote_host: document.getElementById("setting-host").value.trim(),
        remote_user: document.getElementById("setting-user").value.trim(),
        remote_port: parseInt(document.getElementById("setting-port").value) || 22,
        remote_key_path: document.getElementById("setting-key").value.trim(),
        remote_host: document.getElementById("setting-host").value.trim(),
        remote_user: document.getElementById("setting-user").value.trim(),
        remote_port: parseInt(document.getElementById("setting-port").value) || 22,
        remote_key_path: document.getElementById("setting-key").value.trim(),
        spark_host: document.getElementById("setting-host").value.trim(),
        spark_user: document.getElementById("setting-user").value.trim(),
        spark_port: parseInt(document.getElementById("setting-port").value) || 22,
        spark_key_path: document.getElementById("setting-key").value.trim(),
        model_url: document.getElementById("setting-model-url").value.trim(),
        remote_root: document.getElementById("setting-root").value.trim()
    };

    try {
        const resp = await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) throw new Error(await resp.text());
        state.config = payload;
        closeSettingsModal();

        const activeHost = state.config.remote_host || state.config.spark_host || "--";
        const activeUser = state.config.remote_user || state.config.spark_user || "";
        document.getElementById("nav-host-display").textContent = activeHost;
        document.getElementById("metric-ip").textContent = activeHost;
        document.getElementById("term-user-host").textContent = activeUser ? `${activeUser}@${activeHost}` : "Terminal";

        await initFileTreeRoot(state.config.remote_root);
        await loadModels();
        initTelemetry();
    } catch (e) {
        alert("Failed to save settings: " + e.message);
    }
}

function testClusterConnection() {
    openSettingsModal();
    testConnectionFromSettings();
}


// =========================================================================
// --- Lucubrate Demo / Presentation Mode (Clean Screenshots) ---
// =========================================================================

const DEMO_ROOT = "~/workspace/neural-kernel";

const DEMO_TREE_DATA = {
    "~/workspace/neural-kernel": {
        name: "neural-kernel",
        path: "~/workspace/neural-kernel",
        is_dir: true,
        expanded: true,
        loaded: true,
        level: 0,
        children: [
            { name: "benchmarks", path: "~/workspace/neural-kernel/benchmarks", is_dir: true, level: 1, expanded: false, loaded: true, children: [
                { name: "throughput.py", path: "~/workspace/neural-kernel/benchmarks/throughput.py", is_dir: false, level: 2 }
            ]},
            { name: "configs", path: "~/workspace/neural-kernel/configs", is_dir: true, level: 1, expanded: false, loaded: true, children: [
                { name: "model_spec.json", path: "~/workspace/neural-kernel/configs/model_spec.json", is_dir: false, level: 2 }
            ]},
            { name: "src", path: "~/workspace/neural-kernel/src", is_dir: true, level: 1, expanded: true, loaded: true, children: [
                { name: "__init__.py", path: "~/workspace/neural-kernel/src/__init__.py", is_dir: false, level: 2 },
                { name: "attention.cu", path: "~/workspace/neural-kernel/src/attention.cu", is_dir: false, level: 2 },
                { name: "engine.py", path: "~/workspace/neural-kernel/src/engine.py", is_dir: false, level: 2 },
                { name: "router.py", path: "~/workspace/neural-kernel/src/router.py", is_dir: false, level: 2 }
            ]},
            { name: "tests", path: "~/workspace/neural-kernel/tests", is_dir: true, level: 1, expanded: false, loaded: true, children: [
                { name: "test_inference.py", path: "~/workspace/neural-kernel/tests/test_inference.py", is_dir: false, level: 2 }
            ]},
            { name: "pyproject.toml", path: "~/workspace/neural-kernel/pyproject.toml", is_dir: false, level: 1 },
            { name: "README.md", path: "~/workspace/neural-kernel/README.md", is_dir: false, level: 1 }
        ]
    },
    "~/workspace/neural-kernel/benchmarks": {
        name: "benchmarks", path: "~/workspace/neural-kernel/benchmarks", is_dir: true, expanded: false, loaded: true, level: 1,
        children: [{ name: "throughput.py", path: "~/workspace/neural-kernel/benchmarks/throughput.py", is_dir: false, level: 2 }]
    },
    "~/workspace/neural-kernel/configs": {
        name: "configs", path: "~/workspace/neural-kernel/configs", is_dir: true, expanded: false, loaded: true, level: 1,
        children: [{ name: "model_spec.json", path: "~/workspace/neural-kernel/configs/model_spec.json", is_dir: false, level: 2 }]
    },
    "~/workspace/neural-kernel/src": {
        name: "src", path: "~/workspace/neural-kernel/src", is_dir: true, expanded: true, loaded: true, level: 1,
        children: [
            { name: "__init__.py", path: "~/workspace/neural-kernel/src/__init__.py", is_dir: false, level: 2 },
            { name: "attention.cu", path: "~/workspace/neural-kernel/src/attention.cu", is_dir: false, level: 2 },
            { name: "engine.py", path: "~/workspace/neural-kernel/src/engine.py", is_dir: false, level: 2 },
            { name: "router.py", path: "~/workspace/neural-kernel/src/router.py", is_dir: false, level: 2 }
        ]
    },
    "~/workspace/neural-kernel/tests": {
        name: "tests", path: "~/workspace/neural-kernel/tests", is_dir: true, expanded: false, loaded: true, level: 1,
        children: [{ name: "test_inference.py", path: "~/workspace/neural-kernel/tests/test_inference.py", is_dir: false, level: 2 }]
    }
};

const DEMO_CONTENTS = {
    "~/workspace/neural-kernel/src/engine.py": `"""
Lucubrate Neural Engine: Speculative Verification & PagedAttention Kernel
High-throughput inference pipeline with zero-copy KV cache paging.
"""

from dataclasses import dataclass
from typing import List, Optional, Tuple
import torch
import torch.nn as nn

@dataclass
class CacheBlock:
    block_id: int
    slot_mapping: torch.Tensor
    num_tokens: int = 0
    is_full: bool = False

class PagedAttentionEngine(nn.Module):
    def __init__(self, num_heads: int = 32, head_dim: int = 128, block_size: int = 16):
        super().__init__()
        self.num_heads = num_heads
        self.head_dim = head_dim
        self.block_size = block_size
        self.scale = 1.0 / (head_dim ** 0.5)

    def forward(
        self,
        query: torch.Tensor,
        key_cache: torch.Tensor,
        value_cache: torch.Tensor,
        block_tables: torch.Tensor,
        context_lens: torch.Tensor,
    ) -> torch.Tensor:
        """Computes paged scaled dot-product attention across segmented GPU blocks."""
        batch_size, seq_len, _ = query.shape
        attn_weights = torch.matmul(query, key_cache.transpose(-2, -1)) * self.scale
        attn_probs = torch.softmax(attn_weights, dim=-1)
        return torch.matmul(attn_probs, value_cache)

    def verify_speculative_vectorized(
        self,
        draft_tokens: torch.Tensor,
        target_logits: torch.Tensor,
        temperature: float = 0.2
    ) -> Tuple[torch.Tensor, int]:
        """Vectorized acceptance test eliminating sequential synchronization stalls."""
        probs = torch.softmax(target_logits / temperature, dim=-1)
        greedy_tokens = torch.argmax(probs, dim=-1)
        matches = (greedy_tokens == draft_tokens).int()
        
        # Cumulative product identifies prefix acceptance boundary
        valid_mask = torch.cumprod(matches, dim=0).bool()
        accepted = draft_tokens[valid_mask]
        return accepted, int(valid_mask.sum().item())
`,
    "~/workspace/neural-kernel/src/router.py": `"""
MoE Expert Routing Kernel with Top-K Gating and Load Balancing.
"""

import torch
import torch.nn as nn

class TopKExpertRouter(nn.Module):
    def __init__(self, d_model: int = 4096, num_experts: int = 64, top_k: int = 8):
        super().__init__()
        self.gate = nn.Linear(d_model, num_experts, bias=False)
        self.top_k = top_k

    def forward(self, x: torch.Tensor):
        logits = self.gate(x)
        topk_weights, topk_indices = torch.topk(torch.softmax(logits, dim=-1), self.top_k)
        return topk_weights, topk_indices
`,
    "~/workspace/neural-kernel/README.md": `# Neural Kernel

High-performance PagedAttention and speculative decoding engine optimized for local LLM inference on modern GPU architectures.

## Features
- **Zero-Copy KV Paging**: Segmented block cache with sub-millisecond virtual address translation.
- **Vectorized Rejection Sampling**: Parallel speculative draft verification.
- **Top-K Sparse MoE Routing**: Balanced dispatch across expert weights.
`,
    "~/workspace/neural-kernel/pyproject.toml": `[project]
name = "neural-kernel"
version = "0.1.0"
description = "High-throughput speculative decoding and paged attention engine"
dependencies = [
    "torch>=2.4.0",
    "triton>=3.0.0",
    "numpy>=1.26.0"
]
`
};


const DEMO_MODEL_NAME = "Qwen/Qwen2.5-Coder-32B-Instruct";

function setDemoModels() {
    const select = document.getElementById("model-select");
    if (select) {
        select.innerHTML = `
            <option value="Qwen/Qwen2.5-Coder-32B-Instruct" selected>Qwen/Qwen2.5-Coder-32B-Instruct</option>
            <option value="meta-llama/Llama-3.1-70B-Instruct">meta-llama/Llama-3.1-70B-Instruct</option>
            <option value="deepseek-ai/DeepSeek-Coder-V2">deepseek-ai/DeepSeek-Coder-V2</option>
        `;
        select.value = DEMO_MODEL_NAME;
    }
    state.selectedModel = DEMO_MODEL_NAME;
    const modelEl = document.getElementById("metric-model");
    if (modelEl) modelEl.textContent = DEMO_MODEL_NAME;
}

function initDemoTree() {
    state.currentPath = DEMO_ROOT;
    state.treeData = JSON.parse(JSON.stringify(DEMO_TREE_DATA));
    document.getElementById("current-path-display").textContent = DEMO_ROOT;
    renderFullTree();
}

function initDemoTerminal() {
    const activeTerm = state.terminals[state.activeTerminalId];
    if (activeTerm && activeTerm.term) {
        activeTerm.term.reset();
        activeTerm.term.write("\x1b[32mdeveloper@lucubrate-node:~/workspace/neural-kernel$\x1b[0m python -m benchmarks.throughput --batch-size 32\r\n");
        activeTerm.term.write("\x1b[36m[Lucubrate]\x1b[0m Initializing PagedAttention kernel on GPU 0 (128GB Unified Memory)...\r\n");
        activeTerm.term.write("\x1b[36m[Lucubrate]\x1b[0m Loading weights: Qwen2.5-Coder-32B-Instruct -> done (0.84s)\r\n");
        activeTerm.term.write("\x1b[36m[Lucubrate]\x1b[0m Benchmarking speculative verification pass (Batch: 32, Draft: 4)...\r\n");
        activeTerm.term.write("Throughput:  \x1b[32m184.2 tok/s\x1b[0m  (Speedup: \x1b[33m2.18x\x1b[0m)\r\n");
        activeTerm.term.write("GPU Memory:  \x1b[34m18.6 GB / 128.0 GB\x1b[0m\r\n");
        activeTerm.term.write("Temperature: \x1b[32m39°C\x1b[0m | Power Draw: \x1b[32m7.8W\x1b[0m\r\n\r\n");
        activeTerm.term.write("\x1b[32mdeveloper@lucubrate-node:~/workspace/neural-kernel$\x1b[0m ");
    }
}

function initDemoChat() {
    const historyDiv = document.getElementById("agent-history");
    if (!historyDiv) return;
    historyDiv.innerHTML = "";

    // 1. User Message with real attached file chip
    const userAttached = [{ name: "engine.py", path: "~/workspace/neural-kernel/src/engine.py", is_dir: false }];
    appendChatMessage("user", "Can you inspect the speculative verification pass in `src/engine.py` and optimize the draft token rejection loop?", userAttached);

    // 2. Assistant Message with real thinking stream, real tool call cards, and highlighted markdown
    const assistantMsg = appendChatMessage("assistant", "");
    const headerTitle = assistantMsg.querySelector(".chat-header span:first-child");
    if (headerTitle) headerTitle.textContent = `Lucubrate Agent (${DEMO_MODEL_NAME})`;
    const bodyEl = assistantMsg.querySelector(".chat-body");
    bodyEl.innerHTML = "";

    // A. Real Thought Stream Bar
    const streamEl = document.createElement("div");
    streamEl.className = "chat-thinking-stream completed";
    streamEl.innerHTML = `
        <span class="thinking-spinner" style="display: none;"></span>
        <span class="thinking-label">Thought for 1.8s</span>
        <span class="thinking-ticker"></span>
        <span class="thinking-chevron">▶</span>
    `;

    const detailsEl = document.createElement("div");
    detailsEl.className = "chat-thinking-details";
    detailsEl.innerHTML = `
        <div style="line-height: 1.5; color: #a0a0a0;">
            • Inspecting <code>src/engine.py</code> speculative verification routine.<br>
            • Detected sequential CPU-side Python iteration across candidate draft tokens.<br>
            • Formulating vectorized parallel acceptance test via <code>torch.cumprod</code> to eliminate roundtrip sync stalls.
        </div>
    `;

    streamEl.onclick = () => {
        detailsEl.classList.toggle("open");
        const chevron = streamEl.querySelector(".thinking-chevron");
        if (chevron) chevron.textContent = detailsEl.classList.contains("open") ? "▼" : "▶";
    };

    bodyEl.appendChild(streamEl);
    bodyEl.appendChild(detailsEl);

    // B. Real Tool Call Card
    const toolCall = document.createElement("div");
    toolCall.className = "tool-execution-card";
    toolCall.innerHTML = `<div class="tool-execution-title">[TOOL CALL] read_file</div><pre>{\n  "path": "src/engine.py"\n}</pre>`;
    bodyEl.appendChild(toolCall);

    // C. Real Tool Result Card
    const toolResult = document.createElement("div");
    toolResult.className = "tool-execution-card";
    toolResult.style.borderLeftColor = "#28a745";
    toolResult.innerHTML = `<div class="tool-execution-title" style="color:#28a745">[TOOL RESULT] read_file:</div><pre>Successfully read 1,482 bytes from src/engine.py</pre>`;
    bodyEl.appendChild(toolResult);

    // D. Real Markdown Answer with Syntax Highlighting and Code Block Container
    const answerMarkdown = `I've analyzed the draft token verification loop in \`src/engine.py\`. The current implementation evaluates tokens sequentially, triggering CPU-GPU synchronization overhead on each step.

Here is an optimized vectorized acceptance test that evaluates candidate tokens in parallel:

\`\`\`python
def verify_speculative_vectorized(
    draft_tokens: torch.Tensor,
    target_logits: torch.Tensor,
    temperature: float = 0.2
) -> Tuple[torch.Tensor, int]:
    """Vectorized acceptance test eliminating sequential synchronization stalls."""
    probs = torch.softmax(target_logits / temperature, dim=-1)
    greedy_tokens = torch.argmax(probs, dim=-1)
    matches = (greedy_tokens == draft_tokens).int()
    
    # Cumulative product finds the first rejection boundary in parallel
    valid_mask = torch.cumprod(matches, dim=0).bool()
    accepted = draft_tokens[valid_mask]
    return accepted, int(valid_mask.sum().item())
\`\`\`

### Performance Impact:
* **Latency**: Reduces verification overhead from O(K) roundtrips to a single parallel tensor pass.
* **Speedup**: Verified ~**2.2x throughput increase** in benchmark passes.`;

    const contentDiv = document.createElement("div");
    contentDiv.innerHTML = formatMarkdown(answerMarkdown);
    bodyEl.appendChild(contentDiv);

    // In demo mode, scroll to top so screenshot captures user prompt, thinking ticker, and tool call
    setTimeout(() => {
        historyDiv.scrollTop = 0;
    }, 50);
}

function toggleDemoMode() {
    state.demoMode = !state.demoMode;
    localStorage.setItem("lucubrate_demo_mode", state.demoMode ? "true" : "false");

    const badge = document.getElementById("badge-demo-mode");
    const menuLabel = document.getElementById("menu-demo-mode-label");

    if (state.demoMode) {
        if (badge) badge.style.display = "inline-block";
        if (menuLabel) menuLabel.textContent = "Exit Demo Mode (Live Host)";

        // Set demo navbar values
        document.getElementById("nav-host-display").textContent = "192.168.1.100";
        document.getElementById("term-user-host").textContent = "developer@cluster-node";
        setDemoModels();

        // Set demo telemetry
        document.getElementById("metric-ip").textContent = "192.168.1.100";
        document.getElementById("metric-temp").textContent = "39°C";
        document.getElementById("metric-vram").textContent = "18,642 MB";
        document.getElementById("metric-total-vram").textContent = "124,546 MB";
        document.getElementById("metric-power").textContent = "7.8 W";
        const modelEl = document.getElementById("metric-model");
        if (modelEl) modelEl.textContent = DEMO_MODEL_NAME;

        // Initialize file tree, editor, terminal, and agent chat
        initDemoTree();
        openFileInEditor("~/workspace/neural-kernel/src/engine.py");
        initDemoTerminal();
        initDemoChat();
    } else {
        if (badge) badge.style.display = "none";
        if (menuLabel) menuLabel.textContent = "Demo Mode (Clean Screenshots)";

        // Restore real tree and telemetry
        state.currentPath = state.config.remote_root || "";
        document.getElementById("current-path-display").textContent = state.currentPath || "~";
        const host = state.config.remote_host || state.config.spark_host || "--";
        const user = state.config.remote_user || state.config.spark_user || "";
        document.getElementById("nav-host-display").textContent = host;
        document.getElementById("term-user-host").textContent = user ? `${user}@${host}` : "Terminal";

        // Close demo tabs and re-poll real files
        Object.keys(state.openTabs).forEach(path => {
            if (path.startsWith("~/workspace/neural-kernel")) {
                closeTab(path);
            }
        });
        refreshExplorerTree();

        // Clear demo chat
        const historyDiv = document.getElementById("agent-history");
        if (historyDiv) historyDiv.innerHTML = "";

        // Reload live cluster models
        loadModels();

        // Reconnect/refresh active terminal
        const activeTerm = state.terminals[state.activeTerminalId];
        if (activeTerm && activeTerm.term) {
            activeTerm.term.reset();
            const host = state.config.remote_host || state.config.spark_host || "";
            const user = state.config.remote_user || state.config.spark_user || "";
            activeTerm.term.write(`\x1b[32m[Connected (${activeTerm.name}): ${user}@${host}]\x1b[0m\r\n\r\n`);
        }
    }
}

// Check on startup if demo mode is enabled
window.addEventListener("DOMContentLoaded", () => {
    if (state.demoMode) {
        setTimeout(() => {
            state.demoMode = false;
            toggleDemoMode();
        }, 300);
    }
});
