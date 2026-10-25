/**
 * Renderer root: the app behind the PRSLOY first-run gate (key → folder → app).
 * Split out of main.tsx so the entry stays within its file budget.
 */
import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { FirstRunGate } from "./FirstRunGate.tsx";
import { UpdateReadyNotice } from "./UpdateReadyNotice.tsx";

export function renderAppRoot(App: ComponentType): void {
  const root = document.querySelector("#root");
  if (!root) throw new Error("Renderer root element is missing");
  createRoot(root).render(
    <StrictMode>
      <FirstRunGate>
        <App />
        <UpdateReadyNotice />
      </FirstRunGate>
    </StrictMode>,
  );
}
