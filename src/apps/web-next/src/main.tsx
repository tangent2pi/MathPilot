import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/globals.css";

// 教学端（教师/学生）默认浅色（白色）；不再应用已存的暗色偏好。
// 会话内仍可在「外观」菜单手动切换深色。
document.documentElement.classList.remove("dark");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
