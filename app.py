import os
import sys

# PyInstaller safe streams
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

import json
import time
import asyncio
import threading
import logging
import shlex
from typing import Optional, List, Dict, Any
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import httpx
import paramiko

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("lucubrate")

def get_bundle_dir():
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))

def get_app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

CONFIG_FILE = os.path.join(get_app_dir(), "config.json")

def load_config() -> Dict[str, Any]:
    default_config = {
        "remote_host": "127.0.0.1",
        "remote_user": "username",
        "remote_key_path": "",
        "remote_port": 22,
        "model_url": "http://127.0.0.1:8000/v1",
        "remote_root": "/home/username"
    }
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if "spark_host" in data and "remote_host" not in data:
                    data["remote_host"] = data["spark_host"]
                if "spark_user" in data and "remote_user" not in data:
                    data["remote_user"] = data["spark_user"]
                if "spark_key_path" in data and "remote_key_path" not in data:
                    data["remote_key_path"] = data["spark_key_path"]
                if "spark_port" in data and "remote_port" not in data:
                    data["remote_port"] = data["spark_port"]
                if "remote_host" in data: data["spark_host"] = data["remote_host"]
                if "remote_user" in data: data["spark_user"] = data["remote_user"]
                if "remote_key_path" in data: data["spark_key_path"] = data["remote_key_path"]
                if "remote_port" in data: data["spark_port"] = data["remote_port"]
                default_config.update(data)
        except Exception as e:
            logger.warning(f"Could not read config.json: {e}")
    return default_config

def save_config(cfg: Dict[str, Any]):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

current_config = load_config()

app = FastAPI(title="Lucubrate", version="1.1.0")

STATIC_DIR = os.path.join(get_bundle_dir(), "static")
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def get_ssh_client(override_cfg: Optional[Dict[str, Any]] = None) -> paramiko.SSHClient:
    """Creates an authenticated SSH client using current dynamic configuration."""
    cfg = override_cfg or current_config
    host = cfg.get("remote_host") or cfg.get("spark_host") or "127.0.0.1"
    user = cfg.get("remote_user") or cfg.get("spark_user") or "username"
    port = int(cfg.get("remote_port") or cfg.get("spark_port") or 22)
    raw_key_path = cfg.get("remote_key_path") or cfg.get("spark_key_path") or ""
    key_path = os.path.expanduser(raw_key_path) if raw_key_path else ""

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    if os.path.exists(key_path):
        try:
            pkey = paramiko.Ed25519Key.from_private_key_file(key_path)
            client.connect(host, port=port, username=user, pkey=pkey, timeout=4)
            return client
        except Exception:
            try:
                pkey = paramiko.RSAKey.from_private_key_file(key_path)
                client.connect(host, port=port, username=user, pkey=pkey, timeout=4)
                return client
            except Exception:
                pass

    # Fallback to system default agent/keys
    try:
        client.connect(host, port=port, username=user, timeout=4)
        return client
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Cannot reach remote host ({user}@{host}:{port}): {e}")


@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return f.read()
    return HTMLResponse("<h3>Lucubrate starting up... Please refresh in a moment.</h3>")


# --- Configuration Endpoints ---
@app.get("/api/config")
async def get_app_config():
    return current_config

class ConfigUpdateReq(BaseModel):
    remote_host: Optional[str] = None
    remote_user: Optional[str] = None
    remote_key_path: Optional[str] = ""
    remote_port: Optional[int] = 22
    spark_host: Optional[str] = None
    spark_user: Optional[str] = None
    spark_key_path: Optional[str] = None
    spark_port: Optional[int] = None
    model_url: Optional[str] = "http://127.0.0.1:8000/v1"
    remote_root: Optional[str] = "/home/username"

@app.post("/api/config")
async def update_app_config(req: ConfigUpdateReq):
    global current_config
    data = {k: v for k, v in req.dict().items() if v is not None}
    if "remote_host" in data: data["spark_host"] = data["remote_host"]
    elif "spark_host" in data: data["remote_host"] = data["spark_host"]
    if "remote_user" in data: data["spark_user"] = data["remote_user"]
    elif "spark_user" in data: data["remote_user"] = data["spark_user"]
    if "remote_key_path" in data: data["spark_key_path"] = data["remote_key_path"]
    elif "spark_key_path" in data: data["remote_key_path"] = data["spark_key_path"]
    if "remote_port" in data: data["spark_port"] = data["remote_port"]
    elif "spark_port" in data: data["remote_port"] = data["spark_port"]
    current_config.update(data)
    save_config(current_config)
    return {"status": "saved", "config": current_config}

@app.post("/api/config/test")
async def test_connection(req: ConfigUpdateReq):
    test_results = {"ssh": False, "models": False, "error": None}
    try:
        client = get_ssh_client(req.dict())
        stdin, stdout, stderr = client.exec_command("hostname", timeout=3)
        hname = stdout.read().decode().strip()
        client.close()
        test_results["ssh"] = True
        test_results["hostname"] = hname
    except Exception as e:
        test_results["error"] = f"SSH Failed: {e}"
        return test_results

    try:
        async with httpx.AsyncClient(timeout=3.0) as http_client:
            resp = await http_client.get(f"{req.model_url.rstrip('/')}/api/tags")
            if resp.status_code == 200:
                test_results["models"] = True
    except Exception as e:
        test_results["model_error"] = f"Model Endpoint unreachable: {e}"

    return test_results


# --- Hardware & GPU Telemetry ---
@app.get("/api/gpu/inspect")
async def inspect_gpu():
    """Returns raw nvidia-smi stdout from remote host."""
    try:
        client = get_ssh_client()
        stdin, stdout, stderr = client.exec_command("nvidia-smi", timeout=4)
        out = stdout.read().decode("utf-8", errors="replace")
        client.close()
        return {"output": out}
    except Exception as e:
        return {"output": f"Error running nvidia-smi: {e}"}

@app.get("/api/telemetry")
async def get_telemetry():
    """Queries GPU metrics and memory utilization from the remote host or local system."""
    host = current_config.get("remote_host") or current_config.get("spark_host", "127.0.0.1")
    is_local = host in ("127.0.0.1", "localhost", "0.0.0.0", "")
    
    client = None
    try:
        client = get_ssh_client()
    except Exception:
        client = None

    temp = "--°C"
    power = "--W"
    gpu_util = "0%"
    has_gpu = False
    hardware_name = "Host System"
    used_mem = "-- MB"
    total_mem = "-- MB"

    if client:
        try:
            # Query nvidia-smi over SSH (GPU metrics)
            stdin, stdout, stderr = client.exec_command(
                "nvidia-smi --query-gpu=temperature.gpu,power.draw,utilization.gpu,name --format=csv,noheader,nounits",
                timeout=3
            )
            smi_out = stdout.read().decode().strip()

            # Query unified/system memory over SSH
            stdin, stdout, stderr = client.exec_command("free -m | awk 'NR==2{print $2,$3,$4}'", timeout=3)
            mem_out = stdout.read().decode().strip()
            client.close()

            if smi_out:
                lines = smi_out.splitlines()
                first_line = lines[0] if lines else ""
                parts = [p.strip() for p in first_line.split(",")]
                if len(parts) >= 3:
                    temp = f"{parts[0]}°C"
                    power = f"{parts[1]}W"
                    gpu_util = f"{parts[2]}%"
                    has_gpu = True
                if len(parts) >= 4:
                    hardware_name = parts[3]

            if mem_out:
                mparts = mem_out.split()
                if len(mparts) >= 2:
                    total_mb = int(mparts[0])
                    used_mb = int(mparts[1])
                    used_mem = f"{used_mb:,} MB"
                    total_mem = f"{total_mb:,} MB"

            return {
                "status": "ONLINE",
                "ip": host,
                "has_gpu": has_gpu,
                "temp": temp,
                "power": power,
                "gpu_util": gpu_util,
                "used_mem": used_mem,
                "total_mem": total_mem,
                "hardware": hardware_name
            }
        except Exception as e:
            if client:
                try: client.close()
                except Exception: pass
            logger.debug(f"Telemetry SSH query error: {e}")

    # Fallback: If local machine, query local nvidia-smi if installed
    if is_local or not client:
        try:
            import subprocess
            res = subprocess.run(
                ["nvidia-smi", "--query-gpu=temperature.gpu,power.draw,utilization.gpu,name", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=2
            )
            if res.returncode == 0 and res.stdout.strip():
                parts = [p.strip() for p in res.stdout.strip().splitlines()[0].split(",")]
                if len(parts) >= 3:
                    temp = f"{parts[0]}°C"
                    power = f"{parts[1]}W"
                    gpu_util = f"{parts[2]}%"
                    has_gpu = True
                if len(parts) >= 4:
                    hardware_name = parts[3]
        except Exception:
            pass

    return {
        "status": "ONLINE" if has_gpu or is_local else "OFFLINE",
        "ip": host,
        "has_gpu": has_gpu,
        "temp": temp if has_gpu else "N/A",
        "power": power if has_gpu else "N/A",
        "gpu_util": gpu_util if has_gpu else "N/A",
        "used_mem": used_mem,
        "total_mem": total_mem,
        "hardware": hardware_name
    }


# --- Remote File System Operations (SFTP) ---
@app.get("/api/fs/list")
async def list_files(path: Optional[str] = None):
    """Lists files and directories at the specified path on remote host."""
    target_path = path or current_config.get("remote_root", "/home/username")
    try:
        client = get_ssh_client()
        sftp = client.open_sftp()
        try:
            entries = sftp.listdir_attr(target_path)
        except IOError as e:
            sftp.close()
            client.close()
            raise HTTPException(status_code=404, detail=f"Directory not found: {target_path} ({e})")

        items = []
        import stat
        for attr in entries:
            is_dir = stat.S_ISDIR(attr.st_mode)
            is_symlink = stat.S_ISLNK(attr.st_mode)
            item_path = os.path.join(target_path, attr.filename).replace("\\", "/")

            # If it is a symlink, resolve the target to see if it points to a directory
            if is_symlink:
                try:
                    target_stat = sftp.stat(item_path)
                    if stat.S_ISDIR(target_stat.st_mode):
                        is_dir = True
                except Exception:
                    pass

            items.append({
                "name": attr.filename,
                "path": item_path,
                "is_dir": is_dir,
                "is_symlink": is_symlink,
                "size": attr.st_size,
                "mtime": attr.st_mtime
            })
        
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
        sftp.close()
        client.close()
        return {"current_path": target_path, "items": items}
    except Exception as e:
        logger.error(f"List files error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class ReadFileReq(BaseModel):
    path: str

@app.post("/api/fs/read")
async def read_file(req: ReadFileReq):
    try:
        client = get_ssh_client()
        sftp = client.open_sftp()
        with sftp.open(req.path, "r") as f:
            content = f.read().decode("utf-8", errors="replace")
        sftp.close()
        client.close()
        return {"path": req.path, "content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading {req.path}: {e}")


class WriteFileReq(BaseModel):
    path: str
    content: str

@app.post("/api/fs/write")
async def write_file(req: WriteFileReq):
    try:
        client = get_ssh_client()
        sftp = client.open_sftp()
        with sftp.open(req.path, "w") as f:
            f.write(req.content.encode("utf-8"))
        sftp.close()
        client.close()
        return {"success": True, "path": req.path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error writing {req.path}: {e}")


class CreateItemReq(BaseModel):
    path: str
    is_dir: bool = False

@app.post("/api/fs/create")
async def create_item(req: CreateItemReq):
    try:
        client = get_ssh_client()
        sftp = client.open_sftp()
        if req.is_dir:
            stdin, stdout, stderr = client.exec_command(f"mkdir -p {shlex.quote(req.path)}")
            err = stderr.read().decode().strip()
            if err:
                raise Exception(err)
        else:
            parent = os.path.dirname(req.path).replace("\\", "/")
            if parent:
                client.exec_command(f"mkdir -p {shlex.quote(parent)}")
            with sftp.open(req.path, "w") as f:
                f.write(b"")
        sftp.close()
        client.close()
        return {"success": True, "path": req.path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class DeleteItemReq(BaseModel):
    path: str
    is_dir: bool = False

@app.post("/api/fs/delete")
async def delete_item(req: DeleteItemReq):
    try:
        client = get_ssh_client()
        stdin, stdout, stderr = client.exec_command(f"rm -rf {shlex.quote(req.path)}")
        err = stderr.read().decode().strip()
        client.close()
        if err:
            raise Exception(err)
        return {"success": True, "path": req.path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class RenameItemReq(BaseModel):
    old_path: str
    new_path: str

@app.post("/api/fs/rename")
async def rename_item(req: RenameItemReq):
    try:
        client = get_ssh_client()
        sftp = client.open_sftp()
        sftp.rename(req.old_path, req.new_path)
        sftp.close()
        client.close()
        return {"success": True, "old_path": req.old_path, "new_path": req.new_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Local Models & Inference Endpoints ---
_models_cache = {"timestamp": 0.0, "base": "", "models": []}

async def get_live_model_names(model_base: str) -> List[str]:
    """Queries live model IDs from vLLM or Ollama / local LLM host, with 30s cache."""
    global _models_cache
    now = time.time()
    if _models_cache["base"] == model_base and (now - _models_cache["timestamp"]) < 30.0 and _models_cache["models"]:
        return _models_cache["models"]

    models = []
    # 1. Try OpenAI-compatible /v1/models (vLLM, SGLang, or Ollama)
    try:
        url = f"{model_base}/v1/models" if not model_base.endswith("/v1") else f"{model_base}/models"
        async with httpx.AsyncClient(timeout=3.0) as http_client:
            resp = await http_client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                for item in data.get("data", []):
                    if "id" in item:
                        models.append(item["id"])
                if models:
                    _models_cache["timestamp"] = now
                    _models_cache["base"] = model_base
                    _models_cache["models"] = models
                    return models
    except Exception:
        pass

    # 2. Try native Ollama /api/tags
    try:
        ollama_base = model_base.replace("/v1", "")
        async with httpx.AsyncClient(timeout=3.0) as http_client:
            resp = await http_client.get(f"{ollama_base}/api/tags")
            if resp.status_code == 200:
                data = resp.json()
                for m in data.get("models", []):
                    if "name" in m:
                        models.append(m["name"])
                if models:
                    _models_cache["timestamp"] = now
                    _models_cache["base"] = model_base
                    _models_cache["models"] = models
                    return models
    except Exception:
        pass

    return models


@app.get("/api/models")
async def get_models():
    """Queries live models from vLLM or Ollama / local LLM host. Returns only real live models."""
    model_base = current_config.get("model_url", "http://127.0.0.1:8000/v1").rstrip("/")
    models = await get_live_model_names(model_base)
    if models:
        return {"models": models, "source": "vLLM / OpenAI API"}
    return {"models": [], "error": f"No active model server responding at {model_base}"}


class CompleteReq(BaseModel):
    prefix: str
    suffix: Optional[str] = ""
    model: Optional[str] = None
    max_tokens: Optional[int] = 48

@app.post("/api/complete")
async def ai_complete(req: CompleteReq):
    """Fill-In-The-Middle or code completion supporting both vLLM (/v1/completions) and Ollama."""
    model_base = current_config.get("model_url", "http://127.0.0.1:8000/v1").rstrip("/")
    
    # Auto-resolve target model against live cluster models
    target_model = req.model
    live_models = await get_live_model_names(model_base)
    if live_models:
        if not target_model or target_model not in live_models:
            target_model = live_models[0]
    elif not target_model:
        target_model = "Qwen/Qwen2.5-Coder-7B-Instruct"

    clean_suffix = (req.suffix or "").strip()
    if clean_suffix:
        prompt = f"<|fim_prefix|>{req.prefix}<|fim_suffix|>{req.suffix}<|fim_middle|>"
    else:
        prompt = req.prefix[-2048:]

    # 1. Try standard OpenAI /v1/completions (vLLM)
    try:
        url = f"{model_base}/completions" if model_base.endswith("/v1") else f"{model_base}/v1/completions"
        payload = {
            "model": target_model,
            "prompt": prompt,
            "max_tokens": req.max_tokens or 48,
            "temperature": 0.2,
            "stop": ["<|fim_prefix|>", "<|fim_suffix|>", "<|endoftext|>", "\n\n"]
        }
        async with httpx.AsyncClient(timeout=8.0) as http_client:
            resp = await http_client.post(url, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                choices = data.get("choices", [])
                if choices:
                    return {"completion": choices[0].get("text", "")}
    except Exception as e:
        logger.debug(f"vLLM complete attempt failed: {e}")

    # 2. Try Ollama native /api/generate
    try:
        ollama_url = model_base.replace("/v1", "") + "/api/generate"
        payload = {
            "model": target_model,
            "prompt": prompt,
            "stream": False,
            "options": { "num_predict": req.max_tokens or 48, "temperature": 0.2 }
        }
        async with httpx.AsyncClient(timeout=8.0) as http_client:
            resp = await http_client.post(ollama_url, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                return {"completion": data.get("response", "")}
    except Exception as e:
        logger.error(f"Complete error: {e}")

    return {"completion": ""}


# --- Agentic Loop ---
class AgentChatReq(BaseModel):
    messages: List[Dict[str, Any]]
    model: Optional[str] = "qwen2.5-coder:14b"
    active_file: Optional[str] = None
    active_content: Optional[str] = None
    attached_files: Optional[List[Dict[str, Any]]] = None

SYSTEM_PROMPT = """You are Lucubrate Engineer, an autonomous AI systems engineer directly connected to a remote computing environment and local LLM runtime.

You have direct access to tools on the host. When you need to read files, write files, inspect directories, or run commands, output a single JSON block wrapped in ```tool and ```.

Available Tools:
1. read_file: {"tool": "read_file", "args": {"path": "/path/to/file"}}
2. write_file: {"tool": "write_file", "args": {"path": "/path/to/file", "content": "full file content"}}
3. edit_file: {"tool": "edit_file", "args": {"path": "/path/to/file", "target": "exact text to replace", "replacement": "new replacement text"}}
4. list_dir: {"tool": "list_dir", "args": {"path": "/path/to/dir"}}
5. run_command: {"tool": "run_command", "args": {"command": "shell command to run on host"}}

Rules:
- Be concise, dense, and unpretentious. Speak like a senior systems engineer.
- Whenever presenting code, commands, or snippets in your response, ALWAYS wrap them in standard markdown code fences with the exact language identifier (e.g. ```python\n# code\n``` or ```bash\n# command\n```). Never output bare, raw, or unformatted code.
- When asked to run or execute code, tests, or scripts, ALWAYS use `run_command` to perform remote execution directly on the host.
- Check file contents before making edits.
- Format code blocks with standard syntax highlighting.
- Never output internal chain-of-thought scratchpad in the final response. Output only the clean answer.
"""

def execute_remote_tool(tool_name: str, args: Dict[str, Any]) -> str:
    try:
        client = get_ssh_client()
        root_dir = current_config.get("remote_root", "/home/username")
        if tool_name == "read_file":
            path = args.get("path", "")
            sftp = client.open_sftp()
            with sftp.open(path, "r") as f:
                content = f.read().decode("utf-8", errors="replace")
            sftp.close()
            client.close()
            return f"[File: {path}]\n{content}"

        elif tool_name == "write_file":
            path = args.get("path", "")
            content = args.get("content", "")
            sftp = client.open_sftp()
            with sftp.open(path, "w") as f:
                f.write(content.encode("utf-8"))
            sftp.close()
            client.close()
            return f"Successfully wrote {len(content)} bytes to {path}."

        elif tool_name == "edit_file":
            path = args.get("path", "")
            target = args.get("target", "")
            replacement = args.get("replacement", "")
            sftp = client.open_sftp()
            with sftp.open(path, "r") as f:
                content = f.read().decode("utf-8", errors="replace")
            if target not in content:
                sftp.close()
                client.close()
                return f"Error: Target text not found in {path}."
            new_content = content.replace(target, replacement, 1)
            with sftp.open(path, "w") as f:
                f.write(new_content.encode("utf-8"))
            sftp.close()
            client.close()
            return f"Successfully replaced target in {path}."

        elif tool_name == "list_dir":
            path = args.get("path", root_dir)
            sftp = client.open_sftp()
            items = sftp.listdir(path)
            sftp.close()
            client.close()
            return f"[Directory: {path}]\n" + "\n".join(items[:100])

        elif tool_name == "run_command":
            command = args.get("command", "")
            stdin, stdout, stderr = client.exec_command(f"cd {root_dir} && {command}", timeout=30)
            out = stdout.read().decode("utf-8", errors="replace")
            err = stderr.read().decode("utf-8", errors="replace")
            client.close()
            res = ""
            if out: res += out
            if err: res += f"\n[stderr]\n{err}"
            return res.strip() or "[Command executed with 0 output]"

        else:
            client.close()
            return f"Unknown tool: {tool_name}"
    except Exception as e:
        return f"Tool execution failed: {e}"


@app.post("/api/agent/chat")
async def agent_chat(req: AgentChatReq):
    """Streaming agentic chat that connects via standard OpenAI /v1/chat/completions (vLLM / Ollama)."""
    model_base = current_config.get("model_url", "http://127.0.0.1:8000/v1").rstrip("/")
    chat_url = f"{model_base}/chat/completions" if model_base.endswith("/v1") else f"{model_base}/v1/chat/completions"

    # Auto-resolve target model against live cluster models
    target_model = req.model
    live_models = await get_live_model_names(model_base)
    if live_models:
        if not target_model or target_model not in live_models:
            target_model = live_models[0]
    elif not target_model:
        target_model = "Qwen/Qwen2.5-Coder-7B-Instruct"

    # Consolidate all system instructions & context into exactly ONE system message at index 0
    # (vLLM / Qwen Jinja template requires single system message at the beginning)
    system_sections = [SYSTEM_PROMPT.strip()]

    if req.active_file and req.active_content:
        system_sections.append(
            f"Currently open active file in editor:\nPath: {req.active_file}\nContent:\n```\n{req.active_content[:4000]}\n```"
        )

    if req.attached_files:
        for att in req.attached_files:
            path = att.get("path")
            is_dir = att.get("is_dir", False)
            content = att.get("content")
            if is_dir:
                system_sections.append(
                    f"[User Attached Folder Context: {path}]\nDirectory items:\n{content or '[Empty directory]'}"
                )
            elif content is not None:
                system_sections.append(
                    f"[User Attached File Context: {path}]\nContent:\n```\n{content[:8000]}\n```"
                )
            else:
                system_sections.append(
                    f"[User Attached Context Reference: {path}]"
                )

    unified_system_msg = {"role": "system", "content": "\n\n".join(system_sections)}

    # Filter clean dialogue history (only user and assistant roles)
    clean_history = []
    for m in req.messages:
        role = m.get("role")
        content = m.get("content", "")
        if role in ("user", "assistant") and content.strip():
            clean_history.append({"role": role, "content": content})

    messages = [unified_system_msg] + clean_history

    async def event_generator():
        current_messages = list(messages)
        max_turns = 5
        turn = 0

        while turn < max_turns:
            turn += 1
            payload = {
                "model": target_model,
                "messages": current_messages,
                "stream": True,
                "temperature": 0.4
            }

            full_reply = ""
            async with httpx.AsyncClient(timeout=180.0) as http_client:
                try:
                    async with http_client.stream("POST", chat_url, json=payload) as response:
                        if response.status_code != 200:
                            err_body = await response.aread()
                            yield f"data: {json.dumps({'type': 'error', 'content': f'Model Server Error ({response.status_code}): {err_body.decode()[:200]}'})}\n\n"
                            return

                        in_think_tag = False
                        async for line in response.aiter_lines():
                            if not line:
                                continue
                            if line.startswith("data: "):
                                data_str = line[6:].strip()
                                if data_str == "[DONE]":
                                    break
                                try:
                                    chunk = json.loads(data_str)
                                    choices = chunk.get("choices", [])
                                    if choices:
                                        delta = choices[0].get("delta", {})
                                        reasoning_chunk = delta.get("reasoning_content") or delta.get("reasoning")
                                        content_chunk = delta.get("content")

                                        if reasoning_chunk:
                                            yield f"data: {json.dumps({'type': 'reasoning', 'content': reasoning_chunk})}\n\n"

                                        if content_chunk:
                                            if "<think>" in content_chunk and "</think>" in content_chunk:
                                                s_idx = content_chunk.find("<think>")
                                                e_idx = content_chunk.find("</think>")
                                                r_part = content_chunk[s_idx + 7:e_idx]
                                                c_part = content_chunk[:s_idx] + content_chunk[e_idx + 8:]
                                                if r_part:
                                                    yield f"data: {json.dumps({'type': 'reasoning', 'content': r_part})}\n\n"
                                                if c_part:
                                                    full_reply += c_part
                                                    yield f"data: {json.dumps({'type': 'token', 'content': c_part})}\n\n"
                                            elif "<think>" in content_chunk:
                                                in_think_tag = True
                                                s_idx = content_chunk.find("<think>")
                                                before = content_chunk[:s_idx]
                                                after = content_chunk[s_idx + 7:]
                                                if before:
                                                    full_reply += before
                                                    yield f"data: {json.dumps({'type': 'token', 'content': before})}\n\n"
                                                if after:
                                                    yield f"data: {json.dumps({'type': 'reasoning', 'content': after})}\n\n"
                                            elif "</think>" in content_chunk:
                                                in_think_tag = False
                                                e_idx = content_chunk.find("</think>")
                                                r_part = content_chunk[:e_idx]
                                                after = content_chunk[e_idx + 8:]
                                                if r_part:
                                                    yield f"data: {json.dumps({'type': 'reasoning', 'content': r_part})}\n\n"
                                                if after:
                                                    full_reply += after
                                                    yield f"data: {json.dumps({'type': 'token', 'content': after})}\n\n"
                                            elif in_think_tag:
                                                yield f"data: {json.dumps({'type': 'reasoning', 'content': content_chunk})}\n\n"
                                            else:
                                                full_reply += content_chunk
                                                yield f"data: {json.dumps({'type': 'token', 'content': content_chunk})}\n\n"
                                except Exception:
                                    continue
                except Exception as e:
                    yield f"data: {json.dumps({'type': 'error', 'content': f'Connection failed to {chat_url}: {e}'})}\n\n"
                    return

            if "```tool" in full_reply:
                try:
                    start = full_reply.index("```tool") + 7
                    end = full_reply.index("```", start)
                    tool_json_str = full_reply[start:end].strip()
                    tool_call = json.loads(tool_json_str)
                    tool_name = tool_call.get("tool")
                    tool_args = tool_call.get("args", {})

                    yield f"data: {json.dumps({'type': 'tool_start', 'tool': tool_name, 'args': tool_args})}\n\n"
                    
                    loop = asyncio.get_event_loop()
                    tool_result = await loop.run_in_executor(None, execute_remote_tool, tool_name, tool_args)

                    yield f"data: {json.dumps({'type': 'tool_end', 'tool': tool_name, 'result': tool_result})}\n\n"

                    current_messages.append({"role": "assistant", "content": full_reply})
                    current_messages.append({"role": "user", "content": f"Tool '{tool_name}' result:\n{tool_result}\n\nPlease continue."})
                    continue
                except Exception as ex:
                    yield f"data: {json.dumps({'type': 'tool_error', 'error': str(ex)})}\n\n"
                    break
            else:
                break

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# --- Interactive CLI over WebSocket to Remote Host ---
@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket):
    await websocket.accept()
    client = None
    channel = None
    stop_event = asyncio.Event()
    loop = asyncio.get_event_loop()
    reader_task = None
    try:
        client = get_ssh_client()
        channel = client.invoke_shell(term="xterm-256color", width=120, height=36)
        channel.settimeout(0.0)

        async def read_from_remote():
            while not stop_event.is_set():
                try:
                    has_data = await loop.run_in_executor(None, channel.recv_ready)
                    if has_data:
                        raw = await loop.run_in_executor(None, channel.recv, 4096)
                        if raw:
                            await websocket.send_text(raw.decode("utf-8", errors="replace"))
                        else:
                            break
                    else:
                        await asyncio.sleep(0.015)
                except Exception:
                    await asyncio.sleep(0.02)

        reader_task = asyncio.create_task(read_from_remote())

        while True:
            msg = await websocket.receive_text()
            if msg.startswith("{") and "resize" in msg:
                try:
                    evt = json.loads(msg)
                    if evt.get("type") == "resize":
                        cols = int(evt.get("cols", 120))
                        rows = int(evt.get("rows", 36))
                        channel.resize_pty(width=cols, height=rows)
                        continue
                except Exception:
                    pass
            
            # Send raw bytes to Remote PTY
            payload = msg.encode("utf-8") if isinstance(msg, str) else msg
            await loop.run_in_executor(None, channel.sendall, payload)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"WebSocket Terminal Error: {e}")
    finally:
        stop_event.set()
        if reader_task:
            reader_task.cancel()
        if channel:
            channel.close()
        if client:
            client.close()
