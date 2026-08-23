"""Real local-Worker association test for connection-id collisions.

An unrelated manual edge may already own the readable id generated for a new
pair. The browser must preserve that edge and send a repaired id for the new
association; the Worker remains authoritative if the client is stale.
"""

from playwright.sync_api import expect, sync_playwright


BASE = "http://127.0.0.1:8787/agent-studio/"


def call_api(page, path, method="GET", body=None):
    return page.evaluate(
        """
        async ({path, method, body}) => {
          const csrf = document.cookie.split('; ').find((part) => part.startsWith('cail_csrf_agentstudio='))?.split('=')[1];
          const headers = {'X-CSRF-Token': decodeURIComponent(csrf || '')};
          if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
          const response = await fetch(path, {
            method,
            headers,
            credentials: 'include',
            body: body === undefined || body === null ? undefined : JSON.stringify(body),
          });
          return {status: response.status, body: await response.json().catch(() => null)};
        }
        """,
        {"path": path, "method": method, "body": body},
    )


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    workspace_id = None
    try:
        page.goto(BASE, wait_until="networkidle")
        page.get_by_role("button", name="Start blank").click()
        page.wait_for_url("**workspace=*")
        workspace_id = page.url.split("workspace=", 1)[1]

        panels = [
            {"id": "a", "type": "markdown", "title": "A", "content": "A", "layout": {"x": 80, "y": 120, "width": 300, "height": 200}},
            {"id": "b", "type": "markdown", "title": "B", "content": "B", "layout": {"x": 440, "y": 120, "width": 300, "height": 200}},
            {"id": "c", "type": "markdown", "title": "C", "content": "C", "layout": {"x": 80, "y": 460, "width": 300, "height": 200}},
            {"id": "d", "type": "markdown", "title": "D", "content": "D", "layout": {"x": 440, "y": 460, "width": 300, "height": 200}},
        ]
        for panel in panels:
            response = call_api(page, f"/agent-studio/api/workspaces/{workspace_id}/panels", "POST", {"panel": panel})
            assert response["status"] == 200, response

        manual_edge = {"id": "connection-c-d", "sourceId": "a", "targetId": "b"}
        response = call_api(
            page,
            f"/agent-studio/api/workspaces/{workspace_id}/layout",
            "PATCH",
            {"connections": [manual_edge]},
        )
        assert response["status"] == 200, response

        page.goto(f"{BASE}?workspace={workspace_id}", wait_until="networkidle")
        expect(page.locator('[data-connection-id="connection-c-d"]')).to_have_count(1)

        page.locator('[data-panel-id="c"]').focus()
        page.keyboard.press("Enter")
        page.locator('[data-panel-id="d"]').focus()
        page.keyboard.press("Control+Enter")
        page.get_by_role("button", name="Associate selected tiles").click()

        expect(page.locator("[data-connection-id]")).to_have_count(2)
        state = call_api(page, f"/agent-studio/api/workspaces/{workspace_id}")
        assert state["status"] == 200, state
        connections = state["body"]["state"]["connections"]
        assert {tuple(sorted((connection["sourceId"], connection["targetId"]))) for connection in connections} == {("a", "b"), ("c", "d")}
        assert len({connection["id"] for connection in connections}) == 2
        assert next(connection for connection in connections if {connection["sourceId"], connection["targetId"]} == {"a", "b"})["id"] == "connection-c-d"
        assert next(connection for connection in connections if {connection["sourceId"], connection["targetId"]} == {"c", "d"})["id"] != "connection-c-d"
        print({"manual_edge_preserved": True, "new_edge_repaired": True, "connection_count": 2})
    finally:
        if workspace_id:
            call_api(page, f"/agent-studio/api/workspaces/{workspace_id}", "DELETE")
        browser.close()
