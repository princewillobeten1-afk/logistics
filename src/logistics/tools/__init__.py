"""The tool layer (§35).

Two halves that were previously one file and one convention:

- `executor` — idempotent execution. Unchanged from when it was `tools.py`:
  intent → external call → result, with an INTENT and no RESULT treated as
  something to reconcile rather than retry.
- `registry` — what each agent may call, what the arguments must look like,
  and what policy says about it. Every call passes permission, then schema,
  then the gate, in that order.

Importing this package registers every tool. That is a side effect, and it is
deliberate: a tool that has to be imported somewhere else to exist is a tool
that will one day be missing, and the failure would be an agent quietly
lacking a capability rather than anything that looks like an error.
"""

from logistics.tools.executor import (
    NeedsReconciliation,
    ToolError,
    ToolExecutor,
    ToolResult,
    idempotency_key,
)
from logistics.tools.permissions import AGENT_TOOLS
from logistics.tools.permissions import install as _install_permissions
from logistics.tools.registry import (
    PermissionDenied,
    Tier,
    ToolContext,
    ToolDenied,
    ToolInputError,
    ToolNotFound,
    ToolRegistry,
    ToolSpec,
    registry,
    tool,
)

# Importing the definitions is what puts tools in the registry.
from logistics.tools.definitions import reads as _reads  # noqa: F401
from logistics.tools.definitions import writes as _writes  # noqa: F401

_install_permissions(registry)

__all__ = [
    "AGENT_TOOLS",
    "NeedsReconciliation",
    "PermissionDenied",
    "Tier",
    "ToolContext",
    "ToolDenied",
    "ToolError",
    "ToolExecutor",
    "ToolInputError",
    "ToolNotFound",
    "ToolRegistry",
    "ToolResult",
    "ToolSpec",
    "idempotency_key",
    "registry",
    "tool",
]
