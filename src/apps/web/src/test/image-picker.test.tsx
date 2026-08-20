import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImagePicker } from "../components/ImagePicker";

function ControlledPicker() {
  const [files, setFiles] = useState<File[]>([]);
  return <ImagePicker files={files} onChange={setFiles} label="添加题图" />;
}

function LimitedPicker({ onReject }: { onReject: (message: string) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  return <ImagePicker files={files} onChange={setFiles} label="选择头像" maxFiles={1} maxBytes={1_048_576} onReject={onReject} />;
}

describe("image upload preview", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((file: File) => `blob:${file.name}`) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  afterEach(() => vi.restoreAllMocks());

  it("appends image selections and removes only the chosen preview", async () => {
    render(<ControlledPicker />);
    const input = screen.getByLabelText("添加题图");
    const first = new File(["first"], "geometry.png", { type: "image/png", lastModified: 1 });
    const second = new File(["second"], "draft.jpg", { type: "image/jpeg", lastModified: 2 });

    fireEvent.change(input, { target: { files: [first] } });
    expect(await screen.findByAltText("geometry.png")).toHaveAttribute("src", "blob:geometry.png");
    fireEvent.change(input, { target: { files: [second] } });

    expect(await screen.findByAltText("draft.jpg")).toHaveAttribute("src", "blob:draft.jpg");
    expect(screen.getByText("已选择 2 / 4 张")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除 geometry.png" }));
    await waitFor(() => expect(screen.queryByAltText("geometry.png")).not.toBeInTheDocument());
    expect(screen.getByAltText("draft.jpg")).toBeInTheDocument();
    expect(screen.getByText("已选择 1 / 4 张")).toBeInTheDocument();
  });

  it("rejects an oversized image before adding a preview", () => {
    const onReject = vi.fn();
    render(<LimitedPicker onReject={onReject} />);
    const oversized = new File([new Uint8Array(1_048_577)], "large.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("选择头像"), { target: { files: [oversized] } });

    expect(onReject).toHaveBeenCalledWith("图片不能超过 1.0 MiB。");
    expect(screen.queryByAltText("large.png")).not.toBeInTheDocument();
    expect(screen.getByText("最多 1 张")).toBeInTheDocument();
  });
});
