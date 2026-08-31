"""ComfyUI entry point. The filter and the node classes live in nodes.py.

Kept deliberately thin: the tests import nodes.py directly, and a module that
ComfyUI has already loaded as a package must not be importable a second time
under another name.
"""

from .nodes import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
)

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
