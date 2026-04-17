import { useEffect, useRef, useState } from "react";
import * as commands from "../../lib/commands";
import type { GithubAuthStatus } from "../../lib/commands";
import { TerminalPanel } from "../Terminal/TerminalPanel";

/// Inline GitHub sign-in using the bundled `gh` CLI.
///
/// The auth flow is an interactive device-code exchange: `gh auth login -w`
/// prints a one-time code, opens the browser, and waits for the user to
/// confirm. We wire it through the existing PTY manager so the user sees
/// the same prompts they'd get in a terminal, and poll `gh auth status`
/// every 2s while the flow is active so the UI updates automatically when
/// auth succeeds without the user needing to close anything manually.
export function GitHubAuthSection() {
  const [status, setStatus] = useState<GithubAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [authSessionId, setAuthSessionId] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = async () => {
    try {
      const s = await commands.githubAuthStatus();
      setStatus(s);
      return s;
    } catch {
      setStatus({ logged_in: false, user: null, host: "github.com" });
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const startLogin = async () => {
    const sid = `gh-auth-${Date.now()}`;
    try {
      await commands.githubAuthLogin(sid);
      setAuthSessionId(sid);
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        const s = await refresh();
        if (s?.logged_in) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setAuthSessionId(null);
        }
      }, 2000);
    } catch (e) {
      alert(`Failed to start sign-in: ${e}`);
    }
  };

  const cancelLogin = () => {
    if (authSessionId) {
      commands.terminalKill(authSessionId).catch(() => {});
      setAuthSessionId(null);
    }
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const logout = async () => {
    try {
      await commands.githubAuthLogout();
      await refresh();
    } catch (e) {
      alert(`Sign out failed: ${e}`);
    }
  };

  if (loading) return null;

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium text-text-secondary">GitHub</div>
      {status?.logged_in ? (
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] text-text-primary">
            Signed in
            {status.user ? (
              <span className="text-text-tertiary"> as {status.user}</span>
            ) : null}
          </div>
          <button
            onClick={logout}
            className="text-[11px] px-2 py-1 border border-border-primary rounded hover:bg-bg-tertiary"
          >
            Sign out
          </button>
        </div>
      ) : authSessionId ? (
        <div className="space-y-2">
          <div className="text-[11px] text-text-tertiary">
            Copy the code shown below, then press Enter to open github.com. This
            window will update when sign-in completes.
          </div>
          <div className="relative h-48 border border-border-primary rounded overflow-hidden">
            <TerminalPanel sessionId={authSessionId} cwd="." fontSize={12} />
          </div>
          <button
            onClick={cancelLogin}
            className="text-[11px] px-2 py-1 border border-border-primary rounded hover:bg-bg-tertiary"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-text-tertiary">
            Sign in so Coppice can fetch PRs, check runs, and comments.
          </div>
          <button
            onClick={startLogin}
            className="text-[11px] px-2 py-1 bg-accent-primary text-white rounded hover:opacity-90"
          >
            Sign in with GitHub
          </button>
        </div>
      )}
    </div>
  );
}
