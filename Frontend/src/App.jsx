import { useEffect, useState } from "react";
import Login from "./components/Login";
import Dashboard from "./components/Dashboard";
import API from "./services/api";

export default function App() {
  const isAuthFlowRoute = ["/verify-email", "/reset-password"].includes(window.location.pathname);
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(!isAuthFlowRoute);

  const [recordFeedback, setRecordFeedback] = useState(null);

  useEffect(() => {
    // Remove any Phase 1-3 JavaScript-readable token. Phase 4 sessions use an
    // HttpOnly cookie and are verified by the backend on every protected call.
    sessionStorage.removeItem("cornestone_token");
    if (["/verify-email", "/reset-password"].includes(window.location.pathname)) return undefined;
    let active = true;
    API.get("/auth/me")
      .then((response) => {
        if (!active) return;
        const currentUser = response.data?.user || null;
        setUser(currentUser);
        if (currentUser) sessionStorage.setItem("cornestone_user", JSON.stringify(currentUser));
        else sessionStorage.removeItem("cornestone_user");
      })
      .catch(() => {
        if (!active) return;
        sessionStorage.removeItem("cornestone_user");
        setUser(null);
      })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleRecordFeedback = (event) => setRecordFeedback(event.detail || null);
    window.addEventListener("cornestone:record-feedback", handleRecordFeedback);
    return () => window.removeEventListener("cornestone:record-feedback", handleRecordFeedback);
  }, []);

  useEffect(() => {
    const handleExpiredSession = () => {
      setUser(null);
    };
    window.addEventListener("cornestone:session-expired", handleExpiredSession);
    return () => window.removeEventListener("cornestone:session-expired", handleExpiredSession);
  }, []);

  const handleLogout = async () => {
    try { await API.post("/auth/logout"); } catch { /* Clear local UI even if the server is unavailable. */ }
    sessionStorage.removeItem("cornestone_token");
    sessionStorage.removeItem("cornestone_user");
    setUser(null);
  };

  let page;
  if (checkingSession) {
    page = <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm font-semibold text-white">Checking your CORNESTONE session...</div>;
  } else if (!user || isAuthFlowRoute) {
    page = <Login onLoginSuccess={(loggedInUser) => setUser(loggedInUser)} />;
  } else {
    page = <Dashboard user={user} onLogout={handleLogout} />;
  }

  return (
    <>
      {page}
      {recordFeedback && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/45 p-4" role="presentation">
          <div role="alertdialog" aria-modal="true" aria-labelledby="record-feedback-title" aria-describedby="record-feedback-message"
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full text-3xl font-black ${recordFeedback.type === "success" ? "bg-emerald-100 text-emerald-700" : recordFeedback.type === "warning" ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-700"}`} aria-hidden="true">
              {recordFeedback.type === "success" ? "✓" : recordFeedback.type === "warning" ? "!" : "✕"}
            </div>
            <h2 id="record-feedback-title" className={`mt-4 text-center text-xl font-bold ${recordFeedback.type === "success" ? "text-emerald-800" : recordFeedback.type === "warning" ? "text-amber-800" : "text-rose-800"}`}>
              {recordFeedback.type === "success" ? "Record saved" : recordFeedback.type === "warning" ? "Save status unknown" : "Record not saved"}
            </h2>
            <p id="record-feedback-message" className="mt-2 whitespace-pre-wrap break-words text-center text-sm text-slate-700">{recordFeedback.message}</p>
            <button autoFocus type="button" onClick={() => setRecordFeedback(null)} className={`mt-6 w-full rounded-lg px-4 py-2.5 font-semibold text-white ${recordFeedback.type === "success" ? "bg-emerald-700 hover:bg-emerald-800" : recordFeedback.type === "warning" ? "bg-amber-700 hover:bg-amber-800" : "bg-rose-700 hover:bg-rose-800"}`}>
              OK
            </button>
          </div>
        </div>
      )}
    </>
  );
}
