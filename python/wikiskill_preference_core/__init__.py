"""Independent personal preference group mode for WikiSkill."""

from .classification import classify_group
from .config import PreferenceConfig, default_config
from .contracts import (
    EvolutionAction,
    EvolutionChange,
    EvolutionResponse,
    GroupActivationDocument,
    GroupActivationDocumentV2,
    GroupClassificationRequest,
    GroupClassificationResult,
    PreferenceEvent,
    PreferenceGroup,
    PreferenceGroupV2,
    PreferenceGroupsDocument,
    PreferenceGroupsDocumentV2,
    PreferenceRuleV2,
    Signal,
)
from .learning_contracts import Change, Proposal, ProposalJob
from .proposals import ProposalStore
from .store import PreferenceStore

__all__ = [
    "Change",
    "EvolutionAction",
    "EvolutionChange",
    "EvolutionResponse",
    "GroupActivationDocument",
    "GroupActivationDocumentV2",
    "GroupClassificationRequest",
    "GroupClassificationResult",
    "PreferenceConfig",
    "PreferenceEvent",
    "PreferenceGroup",
    "PreferenceGroupV2",
    "PreferenceGroupsDocument",
    "PreferenceGroupsDocumentV2",
    "PreferenceRuleV2",
    "PreferenceStore",
    "Proposal",
    "ProposalJob",
    "ProposalStore",
    "Signal",
    "classify_group",
    "default_config",
]
