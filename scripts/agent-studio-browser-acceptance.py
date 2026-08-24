#!/usr/bin/env python3
"""Real browser acceptance for the deterministic Agent Studio canvas path.

The script builds the checked-out frontend, starts a local Wrangler Worker, and
uses Playwright against that Worker. It creates a workspace through the home
page, seeds deterministic card panels through the local API (there is no model
call in this path), and then performs the user-visible canvas actions: select,
associate, disconnect, pan, zoom, resize, download, reload, and delete.

This is a browser/process integration test. It does not prove model streaming,
provider routing, or model-generated artifact quality; those belong to the
deterministic Worker/provider seams and their focused tests.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Sequence
from urllib.parse import parse_qs, urljoin, urlparse

from playwright.sync_api import Page, expect, sync_playwright


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 8787
HEALTH_TIMEOUT_SECONDS = 30.0
STATE_TIMEOUT_SECONDS = 10.0


def fail(message: str) -> None:
    raise AssertionError(message)


def app_path(base_url: str, suffix: str) -> str:
    base = base_url.rstrip("/") + "/"
    return urljoin(base, suffix.lstrip("/"))


def application_path(base_url: str, suffix: str) -> str:
    pathname = urlparse(base_url).path.rstrip("/")
    return f"{pathname}{suffix}" if pathname else suffix


def api_call(page: Page, base_url: str, suffix: str, method: str = "GET", body: Any = None) -> Dict[str, Any]:
    """Call the local Worker API through the browser's real cookie boundary."""

    path = application_path(base_url, suffix)
    result = page.evaluate(
        """
        async ({path, method, body}) => {
          const csrf = document.cookie
            .split('; ')
            .find((part) => part.startsWith('cail_csrf_agentstudio='))
            ?.split('=')[1];
          const headers = {};
          if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf);
          if (body !== null) headers['Content-Type'] = 'application/json';
          const response = await fetch(path, {
            method,
            headers,
            credentials: 'include',
            body: body === null ? undefined : JSON.stringify(body),
          });
          return {
            status: response.status,
            payload: await response.json().catch(() => null),
          };
        }
        """,
        {"path": path, "method": method, "body": body},
    )
    if result["status"] < 200 or result["status"] >= 300:
        fail(f"{method} {suffix} failed with HTTP {result['status']}")
    payload = result.get("payload")
    return payload if isinstance(payload, dict) else {}


def wait_for_health(base_url: str) -> None:
    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    health_url = app_path(base_url, "health")
    last_error = "health did not respond"
    while time.monotonic() < deadline:
        try:
            import urllib.request

            with urllib.request.urlopen(health_url, timeout=2) as response:
                if response.status == 200:
                    payload = json.loads(response.read().decode("utf-8"))
                    if payload.get("ok") is True:
                        return
                    last_error = "health response was not ready"
        except Exception as error:  # pragma: no cover - startup timing only
            last_error = type(error).__name__
        time.sleep(0.25)
    fail(f"Timed out waiting for local Worker health ({last_error})")


def start_worker(port: int) -> subprocess.Popen[bytes]:
    process = subprocess.Popen(
        [
            "bun",
            "run",
            "--cwd",
            "cloudflare",
            "dev",
            "--port",
            str(port),
            "--show-interactive-dev-session=false",
        ],
        cwd=REPO_ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return process


def stop_worker(process: Optional[subprocess.Popen[bytes]]) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def wait_for_state_change(
    page: Page,
    base_url: str,
    workspace_id: str,
    predicate: Callable[[Dict[str, Any]], bool],
    description: str,
) -> Dict[str, Any]:
    deadline = time.monotonic() + STATE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        payload = api_call(page, base_url, f"/api/workspaces/{workspace_id}")
        if predicate(payload):
            return payload
        time.sleep(0.1)
    fail(f"Timed out waiting for {description}")


def workspace_id_from_url(url: str) -> str:
    values = parse_qs(urlparse(url).query).get("workspace", [])
    if len(values) != 1 or not values[0]:
        fail("Workspace creation did not produce a workspace URL")
    return values[0]


def seed_cards(page: Page, base_url: str, workspace_id: str) -> None:
    panels = [
        {
            "id": "browser-source-cards",
            "type": "cards",
            "title": "Source cards",
            "items": [
                {
                    "id": "source-finding",
                    "title": "Source finding",
                    "subtitle": "Deterministic browser fixture",
                    "description": "This card is seeded through the local Worker API.",
                    "badge": "Verified",
                    "metadata": {"Source": "local acceptance", "Year": "2026"},
                }
            ],
            "layout": {"x": 80, "y": 80, "width": 360, "height": 260},
        },
        {
            "id": "browser-target-cards",
            "type": "cards",
            "title": "Related cards",
            "items": [
                {
                    "id": "related-finding",
                    "title": "Related finding",
                    "subtitle": "Deterministic browser fixture",
                    "description": "The second card supplies the association target.",
                    "badge": "Linked",
                    "metadata": {"Source": "local acceptance", "Year": "2026"},
                }
            ],
            "layout": {"x": 560, "y": 80, "width": 360, "height": 260},
        },
    ]
    for panel in panels:
        api_call(page, base_url, f"/api/workspaces/{workspace_id}/panels", "POST", {"panel": panel})

    api_call(
        page,
        base_url,
        f"/api/workspaces/{workspace_id}/layout",
        "PATCH",
        {
            "panels": {panel["id"]: panel["layout"] for panel in panels},
            "viewport": {"x": -220, "y": -120, "zoom": 0.95},
        },
    )


def select_panel(page: Page, panel_id: str, modifier: Optional[str] = None) -> None:
    panel = page.locator(f'[data-panel-id="{panel_id}"]')
    expect(panel).to_be_visible()
    node = page.locator(f'.react-flow__node[data-id="{panel_id}"]')
    expect(node).to_be_visible()
    node.click(modifiers=[modifier] if modifier else [])


def association_name(source_title: str, target_title: str) -> re.Pattern[str]:
    return re.compile(rf"Association between {re.escape(source_title)} and {re.escape(target_title)}")


def run_acceptance(base_url: str, headed: bool) -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=not headed)
        context = browser.new_context(accept_downloads=True)
        context.set_default_timeout(10_000)
        page = context.new_page()
        page.set_viewport_size({"width": 1440, "height": 1000})
        workspace_id: Optional[str] = None
        cleanup_via_ui = False
        try:
            page.goto(base_url, wait_until="networkidle")
            page.get_by_role("button", name="Start blank").click()
            page.wait_for_url("**workspace=*")
            workspace_id = workspace_id_from_url(page.url)

            seed_cards(page, base_url, workspace_id)
            page.reload(wait_until="networkidle")
            expect(page.get_by_role("heading", name="Source finding")).to_be_visible()
            expect(page.get_by_role("heading", name="Related finding")).to_be_visible()

            name_input = page.get_by_role("textbox", name="Workspace name")
            name_input.fill("Agent Studio browser acceptance")
            page.get_by_role("button", name="Save").click()
            expect(name_input).to_have_value("Agent Studio browser acceptance")

            select_panel(page, "browser-source-cards")
            select_panel(page, "browser-target-cards", "Meta")
            toolbar = page.get_by_role("toolbar", name="Actions for selected tiles")
            expect(toolbar).to_be_visible()

            page.get_by_role("button", name="Associate selected tiles").click()
            association = page.get_by_role("button", name=association_name("Source cards", "Related cards"))
            expect(association).to_have_count(1)

            page.get_by_role("button", name="Disconnect selected tiles").click()
            expect(page.get_by_role("button", name=association_name("Source cards", "Related cards"))).to_have_count(0)

            page.get_by_role("button", name="Associate selected tiles").click()
            expect(page.get_by_role("button", name=association_name("Source cards", "Related cards"))).to_have_count(1)

            state_before_pan = api_call(page, base_url, f"/api/workspaces/{workspace_id}")
            viewport_before_pan = state_before_pan["state"]["viewport"]
            canvas = page.get_by_role("region", name=re.compile(r"Workspace canvas"))
            canvas.focus()
            canvas_box = canvas.bounding_box()
            if canvas_box is None:
                fail("Workspace canvas did not expose a browser bounding box")
            page.mouse.move(canvas_box["x"] + canvas_box["width"] - 80, canvas_box["y"] + canvas_box["height"] - 80)
            page.mouse.down(button="middle")
            page.mouse.move(canvas_box["x"] + canvas_box["width"] - 280, canvas_box["y"] + canvas_box["height"] - 280, steps=10)
            page.mouse.up(button="middle")
            state_after_pan = wait_for_state_change(
                page,
                base_url,
                workspace_id,
                lambda payload: payload["state"]["viewport"] != viewport_before_pan,
                "the user pan to persist",
            )
            viewport_after_pan = state_after_pan["state"]["viewport"]
            if viewport_after_pan["x"] >= viewport_before_pan["x"] or viewport_after_pan["y"] >= viewport_before_pan["y"]:
                fail("Canvas pan did not move the viewport into negative screen coordinates")

            zoom_label = page.get_by_label(re.compile(r"^Zoom \d+ percent$"))
            zoom_before = zoom_label.get_attribute("aria-label")
            page.get_by_role("button", name="Zoom out").click()
            expect(zoom_label).not_to_have_attribute("aria-label", zoom_before or "")
            page.get_by_role("button", name="Zoom in").click()

            page.get_by_role("button", name="Reset zoom and position").click()
            page.reload(wait_until="networkidle")
            expect(page.get_by_role("heading", name="Source finding")).to_be_visible()
            select_panel(page, "browser-source-cards")
            toolbar = page.get_by_role("toolbar", name="Actions for Source cards")
            expect(toolbar).to_be_visible()
            toolbar_before_resize = toolbar.bounding_box()
            if toolbar_before_resize is None:
                fail("Selection toolbar did not expose a browser bounding box")

            panel = page.locator('[data-panel-id="browser-source-cards"]')
            node = panel.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' react-flow__node ')]")
            resize_handle = node.locator(".react-flow__resize-control.handle.bottom.right")
            expect(resize_handle).to_be_visible()
            handle_box = resize_handle.bounding_box()
            if handle_box is None:
                fail("Selected card did not expose a visible resize handle")
            page.mouse.move(handle_box["x"] + handle_box["width"] / 2, handle_box["y"] + handle_box["height"] / 2)
            page.mouse.down()
            page.mouse.move(handle_box["x"] + handle_box["width"] / 2 + 80, handle_box["y"] + handle_box["height"] / 2 + 40, steps=8)
            page.mouse.up()
            wait_for_state_change(
                page,
                base_url,
                workspace_id,
                lambda payload: next(
                    panel for panel in payload["state"]["panels"] if panel["id"] == "browser-source-cards"
                )["layout"]["width"] > 360,
                "the resized card layout to persist",
            )
            toolbar_after_resize = toolbar.bounding_box()
            if toolbar_after_resize is None:
                fail("Selection toolbar disappeared after card resize")
            if (
                abs(toolbar_after_resize["width"] - toolbar_before_resize["width"]) > 1
                or abs(toolbar_after_resize["height"] - toolbar_before_resize["height"]) > 1
            ):
                fail("Selection toolbar changed size when the card was resized")

            page.get_by_role("button", name="Download or export").click()
            with page.expect_download(timeout=5000) as download_info:
                page.get_by_role("menuitem", name="JSON").click()
            download = download_info.value
            if download.suggested_filename != "source-cards.json":
                fail(f"Unexpected card download name: {download.suggested_filename}")

            page.reload(wait_until="networkidle")
            expect(page.get_by_role("textbox", name="Workspace name")).to_have_value("Agent Studio browser acceptance")
            expect(page.get_by_role("heading", name="Source finding")).to_be_visible()
            expect(page.get_by_role("heading", name="Related finding")).to_be_visible()
            expect(page.get_by_role("button", name=association_name("Source cards", "Related cards"))).to_have_count(1)
            persisted_state = api_call(page, base_url, f"/api/workspaces/{workspace_id}")
            persisted_panels = persisted_state["state"]["panels"]
            source_panel = next(panel for panel in persisted_panels if panel["id"] == "browser-source-cards")
            if source_panel["layout"]["width"] <= 360:
                fail("Card resize did not survive reload")

            page.once("dialog", lambda dialog: dialog.accept())
            page.get_by_role("button", name="Delete workspace").click()
            expect(page.get_by_role("button", name="Start blank")).to_be_visible()
            cleanup_via_ui = True
            print("[browser] visible workspace creation, cards, title save, association, disconnect, pan, zoom, resize, download, reload, and UI cleanup passed")
        finally:
            if workspace_id and not cleanup_via_ui:
                try:
                    api_call(page, base_url, f"/api/workspaces/{workspace_id}", "DELETE")
                except Exception:
                    pass
            context.close()
            browser.close()


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("AGENT_STUDIO_BROWSER_URL"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("AGENT_STUDIO_BROWSER_PORT", DEFAULT_PORT)))
    parser.add_argument("--no-build", action="store_true", help="Use an already-built frontend")
    parser.add_argument("--headed", action="store_true", help="Show the Chromium window")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    worker: Optional[subprocess.Popen[bytes]] = None
    base_url = args.url
    try:
        if not base_url:
            if not args.no_build:
                subprocess.run(["bun", "run", "build"], cwd=REPO_ROOT, check=True)
            worker = start_worker(args.port)
            base_url = f"http://127.0.0.1:{args.port}/agent-studio/"
        assert base_url is not None
        wait_for_health(base_url)
        run_acceptance(base_url, args.headed)
        return 0
    except Exception as error:
        print(f"[browser] acceptance failed: {error}", file=sys.stderr)
        return 1
    finally:
        stop_worker(worker)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
