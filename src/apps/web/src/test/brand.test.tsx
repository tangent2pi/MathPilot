import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Brand } from "../components/Brand";

describe("product brand", () => {
  it("uses the MathPilot name and supplied product icon", () => {
    const { container } = render(<MemoryRouter><Brand /></MemoryRouter>);

    expect(screen.getByRole("link", { name: "数学智元 · MathPilot" })).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute("src", "/mathpilot-icon.png");
  });
});
