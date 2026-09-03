"""Independent personal preference group mode for WikiSkill."""

from .classification import classify_group
from .config import PreferenceConfig, default_config
from .contracts import (
    EvolutionAction,
    EvolutionChange,
    EvolutionResponse,
    GroupActivationDocument,
    GroupClassificationRequest,
    GroupClassificationResult,
    PreferenceEvent,
    PreferenceGroup,
    PreferenceGroupsDocument,
    Signal,
)
from .evolution import evolve_preferences
from .store import PreferenceStore

__all__ = [
    "EvolutionAction",
    "EvolutionChange",
    "EvolutionResponse",
    "GroupActivationDocument",
    "GroupClassificationRequest",
    "GroupClassificationResult",
    "PreferenceConfig",
    "PreferenceEvent",
    "PreferenceGroup",
    "PreferenceGroupsDocument",
    "PreferenceStore",
    "Signal",
    "classify_group",
    "default_config",
    "evolve_preferences",
]
