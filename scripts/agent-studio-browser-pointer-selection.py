"""Real local-Worker pointer regression for canvas selection ownership.

This is intentionally a browser boundary check: the visible SVG association
line must own its pointer click, while a drag on empty canvas must still create
the normal two-tile selection.
"""

from playwright.sync_api import expect, sync_playwright


BASE = "http://127.0.0.1:8787/agent-studio/"


def call_api(page, path, method="GET", body=None):
    return page.evaluate(
        """
        async ({path, method, body}) => {
          const csrf = document.cookie.split('; ').find((part) => part.startsWith('cail_csrf_agentstudio='))?.split('=')[1];
          const headers = {'X-CSRF-Token': decodeURIComponent(csrf || '')};
          if (body !== undefined) headers['Content-Type'] = 'application/json';
          const response = await fetch(path, {
            method,
            headers,
            credentials: 'include',
            body: body === undefined ? undefined : JSON.stringify(body),
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
            {
                "id": "pointer-source",
                "type": "markdown",
                "title": "Pointer source",
                "content": "Source content",
                "layout": {"x": 100, "y": 120, "width": 320, "height": 220},
            },
            {
                "id": "pointer-target",
                "type": "cards",
                "title": "Pointer target",
                "items": [{"title": "Target card", "badge": "Strong"}],
                "layout": {"x": 560, "y": 120, "width": 320, "height": 220},
            },
        ]
        for panel in panels:
            response = call_api(page, f"/agent-studio/api/workspaces/{workspace_id}/panels", "POST", {"panel": panel})
            assert response["status"] == 200, response

        edge = {
            "id": "pointer-source-target",
            "sourceId": "pointer-source",
            "targetId": "pointer-target",
        }
        response = call_api(
            page,
            f"/agent-studio/api/workspaces/{workspace_id}/layout",
            "PATCH",
            {"connections": [edge]},
        )
        assert response["status"] == 200, response

        page.reload(wait_until="networkidle")
        line = page.get_by_role("button", name="Association between Pointer source and Pointer target")
        expect(line).to_have_count(1)
        line_point = page.locator('[data-connection-id="pointer-source-target"] path').first.evaluate(
            """
            (path) => {
              const length = path.getTotalLength();
              const local = path.getPointAtLength(length / 2);
              const svgPoint = path.ownerSVGElement.createSVGPoint();
              svgPoint.x = local.x;
              svgPoint.y = local.y;
              const screen = svgPoint.matrixTransform(path.getScreenCTM());
              return {x: screen.x, y: screen.y};
            }
            """
        )
        page.mouse.click(line_point["x"], line_point["y"])
        expect(page.get_by_role("button", name="Disconnect selected tiles")).to_be_visible()
        assert page.get_by_role("button", name="2 selected").count() == 1

        # Clear the line selection before exercising the independent empty-canvas
        # drag path, so a stale selection cannot make this assertion pass.
        page.get_by_role("button", name="2 selected").click()
        expect(page.get_by_role("button", name="Disconnect selected tiles")).to_have_count(0)

        canvas = page.locator('[role="region"][aria-label^="Workspace canvas"]')
        canvas_box = canvas.bounding_box()
        assert canvas_box is not None
        page.mouse.move(canvas_box["x"] + 30, canvas_box["y"] + 30)
        page.mouse.down()
        page.mouse.move(canvas_box["x"] + 980, canvas_box["y"] + 470, steps=12)
        page.mouse.up()
        expect(page.get_by_role("button", name="Disconnect selected tiles")).to_be_visible()
        assert page.get_by_role("button", name="2 selected").count() == 1
        print({"line_click_selected_two": True, "background_drag_selected_two": True})
    finally:
        if workspace_id:
            call_api(page, f"/agent-studio/api/workspaces/{workspace_id}", "DELETE")
        browser.close()
