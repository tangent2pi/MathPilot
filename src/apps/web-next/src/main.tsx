import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Assistant } from "./assistant";
import "./styles/globals.css";

if (localStorage.getItem("mathpilot:theme") === "dark") {
  document.documentElement.classList.add("dark");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Assistant />
  </StrictMode>,
);
