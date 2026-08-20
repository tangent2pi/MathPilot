import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest 未开启 globals 时 RTL 不会自动清理，这里显式注册，避免用例间 DOM 累积。
afterEach(() => cleanup());
