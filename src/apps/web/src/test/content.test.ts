import { describe, expect, it } from "vitest";
import { formatAnswer, stemFormatLabel } from "../lib/content";

describe("content presentation", () => {
  it("renders structured multiple-choice answers for people", () => {
    expect(formatAnswer({ choices: ["A", "C", "D"] })).toBe("A、C、D");
  });

  it("uses a Chinese label for open solutions", () => {
    expect(stemFormatLabel.open_solution).toBe("解答题");
  });
});
