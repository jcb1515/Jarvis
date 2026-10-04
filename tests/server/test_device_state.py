"""Integration tests for the physical-device state WebSocket."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from openjarvis.server.device_state import (
    JarvisRuntimeState,
    RuntimeStateHub,
    create_device_state_router,
)


def _clock_ms() -> int:
    return 1_700_000_000_000


def _make_app(
    enabled: bool,
    token: str,
    heartbeat_interval_s: float,
) -> FastAPI:
    app = FastAPI()
    app.state.physical_device_enabled = enabled
    app.state.physical_device_token = token
    app.state.physical_device_heartbeat_interval_s = heartbeat_interval_s
    app.state.runtime_state_hub = RuntimeStateHub(
        JarvisRuntimeState.READY,
        1_699_999_999_000,
    )
    app.include_router(create_device_state_router(_clock_ms))
    return app


def test_device_state_rejects_missing_and_query_tokens() -> None:
    app = _make_app(True, "device-secret", 15.0)

    with TestClient(app) as client:
        for path in (
            "/v1/devices/state",
            "/v1/devices/state?token=device-secret",
        ):
            try:
                with client.websocket_connect(path):
                    raise AssertionError(
                        "Unauthenticated device connection was accepted"
                    )
            except WebSocketDisconnect as exc:
                assert exc.code == 1008


def test_device_state_fails_closed_without_configured_token() -> None:
    app = _make_app(True, "", 15.0)

    with TestClient(app) as client:
        try:
            with client.websocket_connect(
                "/v1/devices/state",
                headers={"Authorization": "Bearer any-token"},
            ):
                raise AssertionError(
                    "Device connection without a server token succeeded"
                )
        except WebSocketDisconnect as exc:
            assert exc.code == 1011


def test_device_state_sends_snapshot_and_heartbeat() -> None:
    app = _make_app(True, "device-secret", 0.01)

    with TestClient(app) as client:
        with client.websocket_connect(
            "/v1/devices/state",
            headers={"Authorization": "Bearer device-secret"},
        ) as socket:
            snapshot = socket.receive_json()
            heartbeat = socket.receive_json()

    assert snapshot == {
        "type": "jarvis_state",
        "version": 2,
        "state": "READY",
        "sequence": 0,
        "started_at_ms": 1_699_999_999_000,
        "session_started_at_ms": 1_699_999_999_000,
        "server_time_ms": 1_700_000_000_000,
    }
    assert heartbeat == {
        "type": "heartbeat",
        "version": 2,
        "sequence": 0,
        "session_started_at_ms": 1_699_999_999_000,
        "server_time_ms": 1_700_000_000_000,
    }


def test_device_state_broadcasts_ordered_transitions_to_multiple_devices() -> None:
    app = _make_app(True, "device-secret", 15.0)

    @app.post("/test/runtime-state")
    async def publish_test_state() -> dict[str, int | str]:
        snapshot = app.state.runtime_state_hub.publish(
            JarvisRuntimeState.THINKING,
            1_700_000_000_100,
        )
        return {
            "state": snapshot.state.value,
            "sequence": snapshot.sequence,
        }

    headers = {"Authorization": "Bearer device-secret"}
    with TestClient(app) as client:
        with client.websocket_connect(
            "/v1/devices/state",
            headers=headers,
        ) as first:
            with client.websocket_connect(
                "/v1/devices/state",
                headers=headers,
            ) as second:
                first.receive_json()
                second.receive_json()
                response = client.post("/test/runtime-state")
                first_transition = first.receive_json()
                second_transition = second.receive_json()

    assert response.status_code == 200
    assert response.json() == {"state": "THINKING", "sequence": 1}
    assert first_transition == second_transition
    assert first_transition == {
        "type": "jarvis_state",
        "version": 2,
        "state": "THINKING",
        "sequence": 1,
        "started_at_ms": 1_700_000_000_100,
        "session_started_at_ms": 1_699_999_999_000,
        "server_time_ms": 1_700_000_000_000,
    }
