import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/bricolage-grotesque";
import "./styles.css";
import { App } from "./App.tsx";
import { ErrorBoundary, WindowFailed } from "./components/ErrorBoundary.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fallback={details => <WindowFailed details={details} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
