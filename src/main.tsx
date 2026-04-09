import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Note: StrictMode disabled because it double-mounts components in dev,
// which conflicts with PTY lifecycle (spawns duplicate processes).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />
);
