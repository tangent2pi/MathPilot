import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MathText } from "../components/MathText";

describe("MathText", () => {
  it("renders delimited formulas instead of leaving raw LaTeX visible", async () => {
    const { container } = render(<MathText text="在 $\\triangle ABC$ 中，$a=\\sqrt{2}$。" />);

    await waitFor(() => expect(container.querySelectorAll(".katex").length).toBe(2));
    expect(screen.queryByText(/\$\\triangle/)).not.toBeInTheDocument();
  });
});
