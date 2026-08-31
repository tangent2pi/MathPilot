"""Offline pyBKT oracle for test/fixtures/bkt-pybkt-golden.json.

This script is not an online state owner. It injects one fixed, published
single-skill parameter set into pyBKT's official Roster and compares replay
outputs with the fixture consumed by the TypeScript OATutor adapter test.
"""

from __future__ import annotations

import importlib.metadata
import json
import sys
from pathlib import Path

import numpy as np
from pyBKT.models import Model, Roster


FIXTURE = Path(__file__).with_name("fixtures") / "bkt-pybkt-golden.json"


def fit_model(parameters: dict[str, float]) -> dict[str, object]:
    learn = parameters["learn"]
    guess = parameters["guess"]
    slip = parameters["slip"]
    prior = parameters["prior"]
    return {
        "As": np.array([[1.0 - learn, learn], [0.0, 1.0]]),
        "Bn": np.array([[1.0 - guess, guess], [slip, 1.0 - slip]]),
        "pi_0": np.array([[1.0 - prior], [prior]]),
        "learns": np.array([learn]),
        "forgets": np.array([0.0]),
        "slips": np.array([slip]),
        "guesses": np.array([guess]),
        "prior": prior,
        "resource_names": {"default": 0},
        "gs_names": {"default": 0},
    }


def replay(outcomes: list[str], parameters: dict[str, float]) -> float:
    if not outcomes:
        return parameters["prior"]
    model = Model(seed=1)
    model.fit_model = {"dimension": fit_model(parameters)}
    roster = Roster(["student"], ["dimension"], mastery_state=0.95, model=model)
    for outcome in outcomes:
        roster.update_state("dimension", "student", 1 if outcome == "success" else 0)
    return float(roster.get_mastery_prob("dimension", "student"))


def main() -> int:
    fixture = json.loads(FIXTURE.read_text("utf-8"))
    installed = importlib.metadata.version("pyBKT")
    if installed != fixture["oracle_version"]:
        raise RuntimeError(f"pyBKT version {installed} != fixture {fixture['oracle_version']}")
    parameters = fixture["parameter_set"]
    for case in fixture["cases"]:
        actual = replay(case["outcomes"], parameters)
        if abs(actual - case["p_mastery"]) > 1e-9:
            raise AssertionError(f"{case['outcomes']}: pyBKT {actual} != fixture {case['p_mastery']}")
    print(f"pyBKT {installed}: {len(fixture['cases'])} golden cases match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
