"""
Sandbox Manager - Manages persistent sandbox sessions per workspace.

Each workspace gets its own InteractiveSandboxSession with:
- Persistent state between code executions
- Pre-installed libraries (pandas, pypdf, openpyxl, etc.)
- Automatic cleanup after idle timeout
"""

import asyncio
import time
from typing import Optional
from dataclasses import dataclass, field
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Try to import llm-sandbox
try:
    from llm_sandbox import InteractiveSandboxSession
    LLM_SANDBOX_AVAILABLE = True
except ImportError:
    LLM_SANDBOX_AVAILABLE = False
    logger.warning("llm-sandbox not installed. Run: pip install llm-sandbox[docker]")


# Configuration
IDLE_TIMEOUT = 30 * 60  # 30 minutes
EXECUTION_TIMEOUT = 60  # 1 minute per execution
DEFAULT_LIBRARIES = [
    "pandas",
    "numpy",
    "matplotlib",
    "pypdf",
    "pdfplumber",
    "openpyxl",
    "requests",
]


@dataclass
class WorkspaceSession:
    """A sandbox session for a workspace."""
    workspace_id: str
    session: Optional[object] = None  # InteractiveSandboxSession
    created_at: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)

    def is_expired(self) -> bool:
        return time.time() - self.last_used > IDLE_TIMEOUT

    def touch(self):
        self.last_used = time.time()


class SandboxManager:
    """Manages sandbox sessions for workspaces."""

    def __init__(self):
        self.sessions: dict[str, WorkspaceSession] = {}
        self._cleanup_task: Optional[asyncio.Task] = None

    async def start(self):
        """Start the cleanup background task."""
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())
        logger.info("Sandbox manager started")

    async def stop(self):
        """Stop the manager and cleanup all sessions."""
        if self._cleanup_task:
            self._cleanup_task.cancel()

        for ws in list(self.sessions.values()):
            await self._close_session(ws)

        self.sessions.clear()
        logger.info("Sandbox manager stopped")

    async def _cleanup_loop(self):
        """Periodically cleanup expired sessions."""
        while True:
            await asyncio.sleep(60)  # Check every minute

            expired = [
                ws_id for ws_id, ws in self.sessions.items()
                if ws.is_expired()
            ]

            for ws_id in expired:
                logger.info(f"Cleaning up expired session: {ws_id}")
                await self._close_session(self.sessions[ws_id])
                del self.sessions[ws_id]

    async def _close_session(self, ws: WorkspaceSession):
        """Close a workspace session."""
        if ws.session:
            try:
                ws.session.__exit__(None, None, None)
            except Exception as e:
                logger.error(f"Error closing session {ws.workspace_id}: {e}")

    async def get_or_create_session(self, workspace_id: str) -> WorkspaceSession:
        """Get existing session or create new one for workspace."""
        if workspace_id in self.sessions:
            ws = self.sessions[workspace_id]
            ws.touch()
            return ws

        # Create new session
        logger.info(f"Creating new sandbox session for workspace: {workspace_id}")

        ws = WorkspaceSession(workspace_id=workspace_id)

        if LLM_SANDBOX_AVAILABLE:
            try:
                ws.session = InteractiveSandboxSession(
                    lang="python",
                    keep_template=True,
                    verbose=False,
                )
                # Enter the context
                ws.session.__enter__()

                # Pre-install libraries
                for lib in DEFAULT_LIBRARIES:
                    try:
                        ws.session.run(f"import {lib.replace('-', '_')}")
                    except:
                        # Library not in image, try to install
                        ws.session.run(f"!pip install -q {lib}")

                logger.info(f"Session created for workspace: {workspace_id}")
            except Exception as e:
                logger.error(f"Failed to create sandbox session: {e}")
                ws.session = None

        self.sessions[workspace_id] = ws
        return ws

    async def execute(
        self,
        workspace_id: str,
        code: str,
        timeout: int = EXECUTION_TIMEOUT
    ) -> dict:
        """Execute code in workspace's sandbox."""
        ws = await self.get_or_create_session(workspace_id)

        if not ws.session:
            # Fallback: use subprocess with venv Python - isolated but not sandboxed
            logger.warning("No sandbox available, using subprocess fallback")
            import subprocess
            import os

            # Use the venv's Python interpreter
            venv_python = os.path.join(os.path.dirname(__file__), ".venv", "bin", "python")
            if not os.path.exists(venv_python):
                venv_python = "python3"  # Fall back to system Python

            try:
                result = subprocess.run(
                    [venv_python, "-c", code],
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    cwd=os.path.dirname(__file__),
                )
                return {
                    "success": result.returncode == 0,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                    "artifacts": [],
                }
            except subprocess.TimeoutExpired:
                return {
                    "success": False,
                    "stdout": "",
                    "stderr": f"Execution timed out after {timeout} seconds",
                    "artifacts": [],
                }
            except Exception as e:
                return {
                    "success": False,
                    "stdout": "",
                    "stderr": str(e),
                    "artifacts": [],
                }

        try:
            result = ws.session.run(code, timeout=timeout)
            ws.touch()

            return {
                "success": result.exit_code == 0,
                "stdout": result.stdout or "",
                "stderr": result.stderr or "",
                "artifacts": [
                    {"type": "image", "data": img}
                    for img in (result.images or [])
                ],
            }
        except Exception as e:
            logger.error(f"Execution error in {workspace_id}: {e}")
            return {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "artifacts": [],
            }

    async def destroy_session(self, workspace_id: str):
        """Destroy a workspace's session."""
        if workspace_id in self.sessions:
            await self._close_session(self.sessions[workspace_id])
            del self.sessions[workspace_id]
            logger.info(f"Destroyed session for workspace: {workspace_id}")


# FastAPI app
app = FastAPI(title="Agent Studio Sandbox Manager")
manager = SandboxManager()


class ExecuteRequest(BaseModel):
    workspace_id: str
    code: str
    timeout: int = EXECUTION_TIMEOUT


class ExecuteResponse(BaseModel):
    success: bool
    stdout: str
    stderr: str
    artifacts: list


@app.on_event("startup")
async def startup():
    await manager.start()


@app.on_event("shutdown")
async def shutdown():
    await manager.stop()


@app.post("/execute", response_model=ExecuteResponse)
async def execute(request: ExecuteRequest):
    """Execute code in a workspace's sandbox."""
    result = await manager.execute(
        workspace_id=request.workspace_id,
        code=request.code,
        timeout=request.timeout,
    )
    return ExecuteResponse(**result)


@app.delete("/sessions/{workspace_id}")
async def destroy_session(workspace_id: str):
    """Destroy a workspace's session."""
    await manager.destroy_session(workspace_id)
    return {"status": "ok"}


@app.get("/health")
async def health():
    """Health check."""
    return {
        "status": "ok",
        "sandbox_available": LLM_SANDBOX_AVAILABLE,
        "active_sessions": len(manager.sessions),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
