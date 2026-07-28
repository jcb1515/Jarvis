"""REST endpoints for the proactive-agent approval queue."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from openjarvis.tools.approval_execution import (
    ApprovalExecutionError,
    execute_approved_payload,
)
from openjarvis.tools.approval_store import (
    STATUS_APPROVED,
    STATUS_DENIED,
    STATUS_EXECUTED,
    STATUS_EXECUTING,
    STATUS_PENDING,
    ApprovalStore,
    PendingAction,
)

try:
    from fastapi import APIRouter, HTTPException
except ImportError:
    raise ImportError("fastapi is required for approval routes")

logger = logging.getLogger(__name__)

router = APIRouter()

# Singleton that shares the same DB file as ProactiveAgent (WAL mode is safe)
_store: Optional[ApprovalStore] = None


def _get_store() -> ApprovalStore:
    global _store
    if _store is None:
        _store = ApprovalStore()
    return _store


def _serialize(action: PendingAction) -> Dict[str, Any]:
    return {
        "id": action.id,
        "action_type": action.action_type,
        "description": action.description,
        "payload": action.payload,
        "permission_key": action.permission_key,
        "tier": action.tier,
        "status": action.status,
        "created_at": action.created_at,
        "expires_at": action.expires_at,
    }


@router.get("/v1/approvals/pending")
async def list_pending_approvals() -> Dict[str, Any]:
    store = _get_store()
    store.expire_stale()
    now = datetime.now(timezone.utc).isoformat()
    retryable = [
        action
        for action in store.list_approved()
        if action.payload.get("execution_key") and action.expires_at > now
    ]
    actions = sorted(
        [*store.list_pending(), *retryable],
        key=lambda action: action.created_at,
    )
    return {"actions": [_serialize(a) for a in actions], "count": len(actions)}


@router.post("/v1/approvals/{action_id}/approve")
async def approve_action(action_id: str) -> Dict[str, Any]:
    store = _get_store()
    action = store.get_action(action_id)
    if action is None:
        raise HTTPException(status_code=404, detail="Action not found")
    if action.status == STATUS_DENIED:
        raise HTTPException(status_code=409, detail="Denied actions cannot be executed")
    if action.status == STATUS_EXECUTED:
        return {
            "status": "executed",
            "execution_status": "already_executed",
            "id": action_id,
        }

    execution_key = action.payload.get("execution_key")
    if not execution_key:
        if action.status == STATUS_PENDING:
            store.update_status(action_id, STATUS_APPROVED)
        logger.info("Legacy action %s approved via UI", action_id)
        return {
            "status": "approved",
            "execution_status": "not_applicable",
            "id": action_id,
        }

    claimed = False
    for expected_status in (STATUS_PENDING, STATUS_APPROVED):
        if store.compare_and_set_status(
            action_id,
            expected_status,
            STATUS_EXECUTING,
        ):
            claimed = True
            break
    if not claimed:
        current = store.get_action(action_id)
        current_status = current.status if current is not None else "missing"
        raise HTTPException(
            status_code=409,
            detail=f"Action cannot execute from status '{current_status}'",
        )

    try:
        result = execute_approved_payload(action.payload)
    except ApprovalExecutionError as exc:
        store.update_status(action_id, STATUS_APPROVED)
        logger.warning(
            "Approved action could not resolve its provider",
            extra={"action_id": action_id, "execution_key": execution_key},
        )
        return {
            "status": "failed",
            "execution_status": "retryable",
            "id": action_id,
            "result": {"success": False, "content": str(exc)},
        }
    except Exception as exc:
        store.update_status(action_id, STATUS_APPROVED)
        logger.exception(
            "Approved action raised during execution",
            extra={"action_id": action_id, "execution_key": execution_key},
        )
        return {
            "status": "failed",
            "execution_status": "retryable",
            "id": action_id,
            "result": {"success": False, "content": str(exc)},
        }

    if not result.success:
        store.update_status(action_id, STATUS_APPROVED)
        logger.warning(
            "Approved action execution failed",
            extra={"action_id": action_id, "tool": result.tool_name},
        )
        return {
            "status": "failed",
            "execution_status": "retryable",
            "id": action_id,
            "result": {
                "success": False,
                "content": result.content,
                "tool": result.tool_name,
            },
        }

    store.update_status(action_id, STATUS_EXECUTED)
    logger.info(
        "Approved action executed",
        extra={"action_id": action_id, "tool": result.tool_name},
    )
    return {
        "status": "executed",
        "execution_status": "executed",
        "id": action_id,
        "result": {
            "success": True,
            "content": result.content,
            "tool": result.tool_name,
        },
    }


@router.post("/v1/approvals/{action_id}/deny")
async def deny_action(action_id: str) -> Dict[str, Any]:
    store = _get_store()
    action = store.get_action(action_id)
    if action is None:
        raise HTTPException(status_code=404, detail="Action not found")
    if action.status == STATUS_EXECUTED:
        raise HTTPException(status_code=409, detail="Executed actions cannot be denied")
    store.update_status(action_id, STATUS_DENIED)
    logger.info("Action %s denied via UI", action_id)
    return {"status": "denied", "id": action_id}


__all__ = ["router"]
