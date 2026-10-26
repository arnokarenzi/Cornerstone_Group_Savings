import { useEffect, useState } from "react";
import API from "../services/api";

const currentPath = typeof window === "undefined" ? "/" : window.location.pathname;
const searchParams = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
const initialToken = searchParams.get("token") || "";
const initialView = currentPath.endsWith("/verify-email") ? "verify"
  : currentPath.endsWith("/reset-password") ? "reset" : "login";

const inputClass = "w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white transition";
const labelClass = "block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1.5";

export default function Login({ onLoginSuccess }) {
  const [view, setView] = useState(initialView);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [verifyState, setVerifyState] = useState({
    loading: initialView === "verify" && Boolean(initialToken),
    message: initialView === "verify" && !initialToken ? "This verification link is missing its token. Request a new verification email." : "",
    error: initialView === "verify" && !initialToken,
  });

  useEffect(() => {
    if (initialView !== "verify") return;
    if (!initialToken) return;
    let active = true;
    API.post("/auth/verify-email", { token: initialToken }).then((response) => {
      if (active) setVerifyState({ loading: false, message: response.data.message || "Email verified.", error: false });
    }).catch((err) => {
      if (active) setVerifyState({ loading: false, message: err.response?.data?.message || "Email verification failed. Request a new verification email.", error: true });
    });
    return () => { active = false; };
  }, []);

  const changeView = (nextView) => {
    setView(nextView);
    setError("");
    setNotice("");
    setPassword("");
    setConfirmPassword("");
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);
    try {
      const response = await API.post("/auth/login", { email: email.trim(), password });
      if (response.data.success) {
        const { user } = response.data;
        sessionStorage.removeItem("cornestone_token");
        sessionStorage.setItem("cornestone_user", JSON.stringify(user));
        if (onLoginSuccess) onLoginSuccess(user);
      }
    } catch (err) {
      setError(err.response?.data?.message || "Sign-in failed. Please check your credentials.");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError("");
    setNotice("");
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const response = await API.post("/auth/register", {
        fullName: fullName.trim(), email: email.trim(), phoneNumber: phoneNumber.trim(), password,
      });
      setNotice(response.data.message || "Registration submitted. Check your email to verify your address.");
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err.response?.data?.message || "Registration could not be completed.");
    } finally {
      setLoading(false);
    }
  };

  const handleRecovery = async (e, action) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);
    try {
      const endpoint = action === "verify" ? "/auth/resend-verification" : "/auth/forgot-password";
      const response = await API.post(endpoint, { email: email.trim() });
      setNotice(response.data.message || "If an account exists, instructions will be sent shortly.");
    } catch (err) {
      setError(err.response?.data?.message || "The request could not be completed.");
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError("");
    setNotice("");
    if (!initialToken) {
      setError("This reset link is missing its token. Request a new password reset email.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const response = await API.post("/auth/reset-password", { token: initialToken, password });
      setNotice(response.data.message || "Password updated. You can now sign in.");
      setPassword("");
      setConfirmPassword("");
      window.history.replaceState({}, "", "/");
      setView("login");
    } catch (err) {
      setError(err.response?.data?.message || "The password could not be updated.");
    } finally {
      setLoading(false);
    }
  };

  const titles = {
    login: ["Welcome back", "Sign in with the email address attached to your approved company account."],
    register: ["Create your member account", "Verify your email, then wait for a committee member to approve your account."],
    forgot: ["Reset your password", "We will send a one-time password reset link if the account exists."],
    resend: ["Verify your email", "Request another verification link for a pending CORNESTONE account."],
    reset: ["Choose a new password", "Use a password between 12 and 128 characters."],
    verify: ["Email verification", "Verify your email address before committee approval."],
  };
  const [title, subtitle] = titles[view] || titles.login;

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-950 px-4 py-8">
      <div className="w-full max-w-lg p-8 space-y-6 bg-white rounded-2xl shadow-2xl border border-slate-100">
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-emerald-800 text-white rounded-2xl font-extrabold text-2xl mb-1 shadow-lg">C</div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">CORNESTONE Co.LTD.</h1>
          <p className="text-sm text-slate-500">Online Savings &amp; Lending Platform</p>
          <h2 className="text-lg font-bold text-slate-800">{title}</h2>
          <p className="text-xs leading-5 text-slate-400">{subtitle}</p>
        </div>

        {error && <div role="alert" className="p-4 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl font-medium">{error}</div>}
        {notice && <div role="status" className="p-4 text-sm text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-xl">{notice}</div>}

        {view === "verify" && (
          <div className="space-y-4">
            <p role="status" className={`text-sm text-center ${verifyState.error ? "text-rose-700" : "text-slate-600"}`}>
              {verifyState.loading ? "Verifying your email link..." : verifyState.message}
            </p>
            {!verifyState.loading && <button type="button" onClick={() => { window.history.replaceState({}, "", "/"); changeView("login"); }} className="w-full py-3 font-semibold text-white bg-emerald-800 hover:bg-emerald-900 rounded-xl">Continue to Sign In</button>}
          </div>
        )}

        {view === "login" && (
          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label htmlFor="login-email" className={labelClass}>Email address</label>
              <input id="login-email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputClass} />
            </div>
            <div>
              <label htmlFor="login-password" className={labelClass}>Password</label>
              <input id="login-password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className={inputClass} />
            </div>
            <button type="submit" disabled={loading} className="w-full py-3.5 font-semibold text-white bg-emerald-800 hover:bg-emerald-900 rounded-xl shadow-lg shadow-emerald-900/20 disabled:opacity-50 transition">{loading ? "Signing in..." : "Sign In"}</button>
            <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm">
              <button type="button" onClick={() => changeView("forgot")} className="font-semibold text-emerald-800 hover:underline">Forgot password?</button>
              <button type="button" onClick={() => changeView("resend")} className="font-semibold text-emerald-800 hover:underline">Resend verification</button>
            </div>
            <p className="text-center text-sm text-slate-500">New to CORNESTONE? <button type="button" onClick={() => changeView("register")} className="font-bold text-emerald-800 hover:underline">Create an account</button></p>
          </form>
        )}

        {view === "register" && (
          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label htmlFor="register-name" className={labelClass}>Full name</label>
              <input id="register-name" autoComplete="name" required maxLength={255} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your full name" className={inputClass} />
            </div>
            <div>
              <label htmlFor="register-email" className={labelClass}>Email address</label>
              <input id="register-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputClass} />
            </div>
            <div>
              <label htmlFor="register-phone" className={labelClass}>Phone number (optional)</label>
              <input id="register-phone" type="tel" autoComplete="tel" maxLength={50} value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="+250..." className={inputClass} />
            </div>
            <div>
              <label htmlFor="register-password" className={labelClass}>Choose password (12+ characters)</label>
              <input id="register-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="register-confirm" className={labelClass}>Confirm password</label>
              <input id="register-confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} />
            </div>
            <p className="text-xs text-slate-500">New accounts are always created as members. They cannot sign in until the email address is verified and the committee approves the account.</p>
            <button type="submit" disabled={loading} className="w-full py-3.5 font-semibold text-white bg-emerald-800 hover:bg-emerald-900 rounded-xl disabled:opacity-50">{loading ? "Submitting..." : "Create Member Account"}</button>
            <p className="text-center text-sm text-slate-500">Already registered? <button type="button" onClick={() => changeView("login")} className="font-bold text-emerald-800 hover:underline">Sign in</button></p>
          </form>
        )}

        {(view === "forgot" || view === "resend") && (
          <form onSubmit={(e) => handleRecovery(e, view === "resend" ? "verify" : "password")} className="space-y-5">
            <div>
              <label htmlFor="recovery-email" className={labelClass}>Email address</label>
              <input id="recovery-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputClass} />
            </div>
            <button type="submit" disabled={loading} className="w-full py-3.5 font-semibold text-white bg-emerald-800 hover:bg-emerald-900 rounded-xl disabled:opacity-50">{loading ? "Sending..." : view === "resend" ? "Send Verification Link" : "Send Password Reset Link"}</button>
            <div className="text-center text-sm text-slate-500"><button type="button" onClick={() => changeView(view === "resend" ? "forgot" : "resend")} className="font-semibold text-emerald-800 hover:underline">{view === "resend" ? "Need a password reset instead?" : "Need an email verification link instead?"}</button></div>
            <p className="text-center text-sm text-slate-500"><button type="button" onClick={() => changeView("login")} className="font-bold text-emerald-800 hover:underline">Back to Sign In</button></p>
          </form>
        )}

        {view === "reset" && (
          <form onSubmit={handleResetPassword} className="space-y-5">
            <div>
              <label htmlFor="reset-password" className={labelClass}>New password (12+ characters)</label>
              <input id="reset-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="reset-confirm" className={labelClass}>Confirm new password</label>
              <input id="reset-confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} />
            </div>
            <button type="submit" disabled={loading} className="w-full py-3.5 font-semibold text-white bg-emerald-800 hover:bg-emerald-900 rounded-xl disabled:opacity-50">{loading ? "Updating..." : "Update Password"}</button>
            <p className="text-center text-sm text-slate-500"><button type="button" onClick={() => changeView("login")} className="font-bold text-emerald-800 hover:underline">Back to Sign In</button></p>
          </form>
        )}
      </div>
    </div>
  );
}
