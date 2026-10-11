#!/usr/bin/env python3
"""Exercise the packaged app in the disposable CI Compose stack only."""
import json
import os
import time
import urllib.error
import urllib.request

SLUG = "relayqueue"
BASE = "http://127.0.0.1:3000"
KEY = "ci-only-workspace-key-not-a-production-secret"


def request(path, method="GET", body=None, headers=None, expected=200):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json", **(headers or {})})
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        payload = response.read().decode()
        assert response.status == expected, (method, path, response.status, payload[:300])
        if "application/json" in response.headers.get("Content-Type", ""):
            return json.loads(payload)
        return payload


def main():
    # Prevent accidentally pointing this data-mutating smoke test at a real host.
    assert os.environ.get("CI_CONTAINER_SMOKE") == "1", "Use the disposable CI stack only"
    health = {"changeweave": "/healthz", "supportdesk": "/api/health"}.get(SLUG, "/health")
    deadline = time.monotonic() + 90
    while True:
        try:
            request(health)
            break
        except (OSError, AssertionError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)
    assert "<html" in request("/").lower(), "Packaged frontend missing"

    if SLUG in {"tracepilot", "graphrag-studio"}:
        headers = {"X-Workspace-Key": KEY}
        request("/api/meta", expected=401)
        meta = request("/api/meta", headers=headers)
        assert meta["storage"] == "jdbc", meta
        if SLUG == "tracepilot":
            datasets = request("/api/datasets", headers=headers)
            prompts = request("/api/prompts", headers=headers)
            assert datasets and prompts, "PostgreSQL-backed seed was not readable"
            prompt = request("/api/prompts", "POST", {
                "name": "CI container contract", "system": "Use provided context.",
                "template": "Context: {{context}}\nQuestion: {{question}}"
            }, headers, 201)
            assert any(p["id"] == prompt["id"] for p in request("/api/prompts", headers=headers))
        else:
            collection = request("/api/collections", "POST", {
                "name": "CI container contract", "description": "Disposable PostgreSQL smoke",
                "embeddingProvider": "hash", "chunkSize": 1100, "overlap": 120
            }, headers, 201)
            saved = request("/api/collections/" + collection["id"], headers=headers)
            assert saved["name"] == "CI container contract"
    elif SLUG == "supportdesk":
        request("/api/workspaces", expected=401)
        account = request("/api/auth/register", "POST", {
            "email": "ci@example.test", "password": "CiOnlyPassword-42!",
            "name": "CI", "workspace_name": "Disposable CI workspace"
        }, expected=201)
        headers = {"Authorization": "Bearer " + account["token"]}
        wid = request("/api/workspaces", headers=headers)[0]["id"]
        base = f"/api/workspaces/{wid}/tickets"
        ticket = request(base, "POST", {"title": "Container release contract"}, headers, 201)
        path = base + f"/{ticket['id']}"
        saved = request(path, "PATCH", {"version": 1, "title": "Saved through nginx"}, headers)
        assert saved["version"] == 2
        request(path, "PATCH", {"version": 1, "title": "Stale update"}, headers, 409)
        assert request(path, headers=headers)["title"] == "Saved through nginx"
    elif SLUG == "relayqueue":
        request("/api/events", expected=401)
        headers = {"Authorization": "Bearer " + KEY, "Idempotency-Key": "container-smoke"}
        event = request("/api/events", "POST", {"type": "ci.release", "payload": {"test": True}}, headers, 202)
        replay = request("/api/events", "POST", {"type": "ci.release", "payload": {"test": True}}, headers)
        assert event["event"]["id"] == replay["event"]["id"]
    else:
        health_data = request("/healthz")
        assert health_data["ok"] is True
        assert isinstance(request("/api/runs"), list)
        # Bundle must be available from the freshly built image, not only source files.
        assert len(request("/bundle.js")) > 1000
    print(f"Container smoke passed: {SLUG} (frontend, API and persistence/auth where applicable)")


if __name__ == "__main__":
    main()
