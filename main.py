import os
import sys

# PyInstaller --noconsole sets sys.stdout and sys.stderr to None.
# Redirect them so logging and uvicorn never throw AttributeError/ValueError on startup.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

import time
import socket
import threading
import subprocess
import uvicorn

from app import app

def find_free_port(start_port=8765):
    """Finds an available local port starting from start_port."""
    for port in range(start_port, start_port + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('127.0.0.1', port)) != 0:
                return port
    return start_port

PORT = find_free_port(8765)
URL = f"http://127.0.0.1:{PORT}"

def run_backend():
    """Runs the FastAPI server on localhost in a background daemon thread."""
    try:
        config = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_config=None)
        server = uvicorn.Server(config)
        server.run()
    except Exception:
        pass

def wait_for_backend(port, timeout=8.0):
    """Guarantees backend is actively listening on localhost before launching UI window."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.2)
                if s.connect_ex(('127.0.0.1', port)) == 0:
                    return True
        except Exception:
            pass
        time.sleep(0.05)
    return False

def launch_desktop_window():
    """Launches the dedicated native Windows desktop window."""
    # Method 1: Try pywebview (EdgeChromium WebView2)
    try:
        import webview
        window = webview.create_window(
            title="Lucubrate · AI Systems IDE",
            url=URL,
            width=1540,
            height=940,
            min_size=(1024, 720),
            resizable=True,
            text_select=True,
            zoomable=True
        )
        webview.start(gui="edgechromium")
        return
    except Exception:
        pass

    # Method 2: Native Windows Standalone App Mode (Edge app mode)
    try:
        cmd = ["msedge", f"--app={URL}", "--window-size=1540,940", "--new-window"]
        p = subprocess.Popen(cmd)
        p.wait()
    except Exception:
        import webbrowser
        webbrowser.open(URL)
        while True:
            time.sleep(1)

if __name__ == "__main__":
    # Start local backend daemon
    server_thread = threading.Thread(target=run_backend, daemon=True)
    server_thread.start()

    # Block until FastAPI / Uvicorn has successfully bound to the socket!
    wait_for_backend(PORT)

    launch_desktop_window()
