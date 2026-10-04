"""Authenticated read-only WebSocket bridge for physical JARVIS devices."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import Enum
from typing import Callable, TypeAlias

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from openjarvis.server.auth_middleware import websocket_bearer_authorized

DEVICE_PROTOCOL_VERSION = 2

PayloadValue: TypeAlias = str | int
DevicePayload: TypeAlias = dict[str, PayloadValue]
StateQueue: TypeAlias = asyncio.Queue["RuntimeStateSnapshot"]


class JarvisRuntimeState(str, Enum):
    """Runtime states exposed to read-only physical display devices."""

    READY = "READY"
    HEARING = "HEARING"
    THINKING = "THINKING"
    RESPONDING = "RESPONDING"
    SPEAKING = "SPEAKING"
    ERROR = "ERROR"

    @classmethod
    def from_wire_value(cls, value: str) -> "JarvisRuntimeState":
        """Parse a frontend state and normalize legacy response generation."""
        parsed = cls(value.upper())
        if parsed is cls.RESPONDING:
            return cls.THINKING
        return parsed


@dataclass(frozen=True, slots=True)
class RuntimeStateSnapshot:
    """Immutable runtime state revision distributed to subscribers."""

    state: JarvisRuntimeState
    sequence: int
    started_at_ms: int


class RuntimeStateHub:
    """Connect runtime state publishers to physical-device subscribers."""

    def __init__(
        self,
        initial_state: JarvisRuntimeState,
        initial_started_at_ms: int,
    ) -> None:
        self._session_started_at_ms = initial_started_at_ms
        self._snapshot = RuntimeStateSnapshot(
            state=initial_state,
            sequence=0,
            started_at_ms=initial_started_at_ms,
        )
        self._subscribers: set[StateQueue] = set()

    def snapshot(self) -> RuntimeStateSnapshot:
        """Return the current immutable state revision."""
        return self._snapshot

    def session_started_at_ms(self) -> int:
        """Return the stable identifier for this backend process session."""
        return self._session_started_at_ms

    def subscribe(self) -> StateQueue:
        """Register and return an unbounded queue for low-rate state events."""
        queue: StateQueue = asyncio.Queue()
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: StateQueue) -> None:
        """Remove a previously registered subscriber queue."""
        self._subscribers.discard(queue)

    def publish(
        self,
        state: JarvisRuntimeState,
        started_at_ms: int,
    ) -> RuntimeStateSnapshot:
        """Publish a new revision to every active device subscriber."""
        snapshot = RuntimeStateSnapshot(
            state=state,
            sequence=self._snapshot.sequence + 1,
            started_at_ms=started_at_ms,
        )
        self._snapshot = snapshot
        for queue in tuple(self._subscribers):
            queue.put_nowait(snapshot)
        return snapshot


def current_time_ms() -> int:
    """Return the current Unix time in milliseconds."""
    return int(time.time() * 1000)


def state_payload(
    snapshot: RuntimeStateSnapshot,
    session_started_at_ms: int,
    server_time_ms: int,
) -> DevicePayload:
    """Serialize a state revision using the versioned device protocol."""
    return {
        "type": "jarvis_state",
        "version": DEVICE_PROTOCOL_VERSION,
        "state": snapshot.state.value,
        "sequence": snapshot.sequence,
        "started_at_ms": snapshot.started_at_ms,
        "session_started_at_ms": session_started_at_ms,
        "server_time_ms": server_time_ms,
    }


def heartbeat_payload(
    snapshot: RuntimeStateSnapshot,
    session_started_at_ms: int,
    server_time_ms: int,
) -> DevicePayload:
    """Serialize a heartbeat tied to the latest known state revision."""
    return {
        "type": "heartbeat",
        "version": DEVICE_PROTOCOL_VERSION,
        "sequence": snapshot.sequence,
        "session_started_at_ms": session_started_at_ms,
        "server_time_ms": server_time_ms,
    }


def publish_runtime_state(
    hub: RuntimeStateHub,
    state: str,
    started_at_ms: int,
) -> RuntimeStateSnapshot:
    """Normalize and publish a frontend runtime-state transition."""
    return hub.publish(
        JarvisRuntimeState.from_wire_value(state),
        started_at_ms,
    )


def create_device_state_router(
    clock_ms: Callable[[], int],
) -> APIRouter:
    """Create the physical-device state router using an injectable clock."""
    router = APIRouter(tags=["physical-device"])

    @router.websocket("/v1/devices/state")
    async def stream_device_state(websocket: WebSocket) -> None:
        enabled = websocket.app.state.physical_device_enabled
        if not enabled:
            await websocket.close(code=1008, reason="Physical device bridge disabled")
            return

        token = websocket.app.state.physical_device_token
        if not token:
            await websocket.close(code=1011, reason="Physical device token unavailable")
            return
        if not websocket_bearer_authorized(websocket, token):
            await websocket.close(code=1008, reason="Invalid physical device token")
            return

        hub: RuntimeStateHub = websocket.app.state.runtime_state_hub
        heartbeat_interval_s: float = (
            websocket.app.state.physical_device_heartbeat_interval_s
        )
        queue = hub.subscribe()
        await websocket.accept()
        try:
            await websocket.send_json(
                state_payload(
                    hub.snapshot(),
                    hub.session_started_at_ms(),
                    clock_ms(),
                )
            )
            while True:
                try:
                    snapshot = await asyncio.wait_for(
                        queue.get(),
                        timeout=heartbeat_interval_s,
                    )
                    await websocket.send_json(
                        state_payload(
                            snapshot,
                            hub.session_started_at_ms(),
                            clock_ms(),
                        )
                    )
                except TimeoutError:
                    await websocket.send_json(
                        heartbeat_payload(
                            hub.snapshot(),
                            hub.session_started_at_ms(),
                            clock_ms(),
                        )
                    )
        except WebSocketDisconnect:
            return
        finally:
            hub.unsubscribe(queue)

    return router


__all__ = [
    "DEVICE_PROTOCOL_VERSION",
    "JarvisRuntimeState",
    "RuntimeStateHub",
    "RuntimeStateSnapshot",
    "create_device_state_router",
    "current_time_ms",
    "heartbeat_payload",
    "publish_runtime_state",
    "state_payload",
]
