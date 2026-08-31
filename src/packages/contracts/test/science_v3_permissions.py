#!/usr/bin/env python3
"""Static permission invariants for the sealed science-v3 contracts."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent / "schemas" / "science-v3"


def load(name: str) -> dict:
    with (ROOT / name).open() as handle:
        return json.load(handle)


def property_names(node: object) -> set[str]:
    names: set[str] = set()
    if isinstance(node, dict):
        properties = node.get("properties")
        if isinstance(properties, dict):
            names.update(properties)
        for value in node.values():
            names.update(property_names(value))
    elif isinstance(node, list):
        for value in node:
            names.update(property_names(value))
    return names


def main() -> int:
    annotation = load("annotation-change-set.schema.json")
    forbidden_dream_writes = {
        "p_mastery",
        "fsrs_card",
        "stability",
        "difficulty",
        "error_pattern_state",
        "misconception_updates",
        "plan_progress",
        "state_final",
    }
    assert not forbidden_dream_writes.intersection(property_names(annotation))

    commands = load("learning-command.schema.json")
    command_types = {
        definition["allOf"][1]["properties"]["command_type"]["const"]
        for definition in commands["$defs"].values()
        if isinstance(definition, dict) and "allOf" in definition
    }
    assert command_types == {
        "submit_attempt",
        "request_cut",
        "revise_selection_intent",
        "start_review",
        "annotation_feedback",
        "set_context_preference",
        "cancel_operation",
        "teacher_supersede_fact",
    }
    assert not {"set_mastery", "set_retention", "update_error_state", "edit_annotation"}.intersection(command_types)

    task_spec = load("task-spec.schema.json")
    capability_tools = set(task_spec["properties"]["allowed_capability_tools"]["items"]["enum"])
    assert capability_tools == {"question_catalog", "read", "grep", "learning_action", "delegate"}
    assert not {"bash", "sql", "http", "database", "credentials"}.intersection(capability_tools)

    domain_part = load("domain-ui-part.schema.json")
    assert domain_part["properties"]["origin"] == {"const": "domain_projector"}
    assert "href" not in domain_part["properties"]["action_slots"]["items"].get("properties", {})

    flow = load("learning-flow.schema.json")
    question_session = flow["$defs"]["QuestionSession"]
    assert question_session["properties"]["lifecycle"]["enum"] == ["active", "finalizing", "closed", "abandoned"]
    assert "mode" not in question_session["properties"]
    assert "state_history" not in question_session["properties"]

    common = load("common.schema.json")["$defs"]
    identity_patterns = {
        common[name]["pattern"]
        for name in ["ConversationThreadId", "ForegroundEpochId", "QuestionSessionId", "WorkflowId", "AgentAttemptId"]
    }
    assert len(identity_patterns) == 5

    print("PASS: science-v3 permission, authority, identity, and no-legacy-mode invariants hold")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
