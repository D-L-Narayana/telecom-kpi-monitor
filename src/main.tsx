import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, readThemePref } from "./theme";
import "./styles.css";

// Resolve the stored theme preference before the first paint to avoid a light flash in dark mode.
applyTheme(readThemePref());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
