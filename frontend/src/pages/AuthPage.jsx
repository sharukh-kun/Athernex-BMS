import { useState } from "react";
import { motion } from "framer-motion";
import { useAuthStore } from "../store/useAuthStore";

export default function AuthPage() {
  const { login, signup, loginWithGoogle, isLoggingIn } = useAuthStore();

  const [isLogin, setIsLogin] = useState(true);
  const [theme, setTheme] = useState("dark");
  const isDark = theme === "dark";

  const [data, setData] = useState({
    email: "",
    password: "",
    fullName: ""
  });

  const handleSubmit = () => {
    if (isLogin) login(data);
    else signup(data);
  };

  return (
    <div className={`flex min-h-screen items-center justify-center px-4 py-10 ${
      isDark ? "bg-[#212121] text-[#e5e5e5]" : "bg-[#f5f5f5] text-[#111]"
    }`}>

      {/* Toggle */}
      <button
        onClick={() => setTheme(isDark ? "light" : "dark")}
        className={`absolute top-6 right-6 rounded-lg px-4 py-2 text-xs font-semibold border transition ${
          isDark
            ? "border-white/10 hover:bg-white/10"
            : "border-black/10 hover:bg-black/5"
        }`}
      >
        {isDark ? "Light" : "Dark"}
      </button>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className={`w-full max-w-md rounded-2xl p-6 sm:p-8 border ${
          isDark
            ? "bg-[#2a2a2a] border-white/10"
            : "bg-white border-black/10"
        }`}
      >
        <p className={`text-xs font-semibold uppercase tracking-[0.16em] ${
          isDark ? "text-[#888]" : "text-[#666]"
        }`}>
          Account
        </p>

        <h2 className="mt-2 text-2xl font-semibold sm:text-3xl">
          {isLogin ? "Welcome back" : "Create your account"}
        </h2>

        <p className={`mt-2 text-sm ${
          isDark ? "text-[#a3a3a3]" : "text-[#555]"
        }`}>
          {isLogin ? "Sign in to continue." : "Sign up to start a new project."}
        </p>

        {/* Switch */}
        <div className={`mt-6 flex rounded-lg p-1 ${
          isDark ? "bg-[#1f1f1f]" : "bg-[#eaeaea]"
        }`}>
          <button
            onClick={() => setIsLogin(true)}
            className={`flex-1 rounded-md py-2 text-sm font-semibold transition ${
              isLogin
                ? (isDark ? "bg-[#3a3a3a]" : "bg-white shadow")
                : ""
            }`}
          >
            Login
          </button>
          <button
            onClick={() => setIsLogin(false)}
            className={`flex-1 rounded-md py-2 text-sm font-semibold transition ${
              !isLogin
                ? (isDark ? "bg-[#3a3a3a]" : "bg-white shadow")
                : ""
            }`}
          >
            Signup
          </button>
        </div>

        {/* Inputs */}
        <div className="mt-5 space-y-3">
          {!isLogin && (
            <div className="space-y-1">
              <label className={`ml-1 text-xs ${
                isDark ? "text-[#888]" : "text-[#666]"
              }`}>
                Full name
              </label>
              <input
                placeholder="Your name"
                className={`w-full rounded-lg px-3 py-2.5 text-sm outline-none border ${
                  isDark
                    ? "bg-[#1f1f1f] border-white/10 focus:bg-[#262626]"
                    : "bg-white border-black/10 focus:bg-[#fafafa]"
                }`}
                onChange={e => setData({ ...data, fullName: e.target.value })}
              />
            </div>
          )}

          <div className="space-y-1">
            <label className={`ml-1 text-xs ${
              isDark ? "text-[#888]" : "text-[#666]"
            }`}>
              Email
            </label>
            <input
              placeholder="you@example.com"
              className={`w-full rounded-lg px-3 py-2.5 text-sm outline-none border ${
                isDark
                  ? "bg-[#1f1f1f] border-white/10 focus:bg-[#262626]"
                  : "bg-white border-black/10 focus:bg-[#fafafa]"
              }`}
              onChange={e => setData({ ...data, email: e.target.value })}
            />
          </div>

          <div className="space-y-1">
            <label className={`ml-1 text-xs ${
              isDark ? "text-[#888]" : "text-[#666]"
            }`}>
              Password
            </label>
            <input
              placeholder="••••••••"
              type="password"
              className={`w-full rounded-lg px-3 py-2.5 text-sm outline-none border ${
                isDark
                  ? "bg-[#1f1f1f] border-white/10 focus:bg-[#262626]"
                  : "bg-white border-black/10 focus:bg-[#fafafa]"
              }`}
              onChange={e => setData({ ...data, password: e.target.value })}
            />
          </div>
        </div>

        {/* CTA */}
        <button
          onClick={handleSubmit}
          className={`mt-6 w-full rounded-lg py-2.5 text-sm font-semibold transition ${
            isDark
              ? "bg-[#3a3a3a] hover:bg-[#4a4a4a]"
              : "bg-black text-white hover:bg-[#222]"
          }`}
        >
          {isLogin ? "Login" : "Create account"}
        </button>

        <div className="mt-4 flex items-center gap-3">
          <div className={`h-px flex-1 ${isDark ? "bg-white/10" : "bg-black/10"}`} />
          <span className={`text-[11px] uppercase tracking-[0.16em] ${isDark ? "text-[#777]" : "text-[#888]"}`}>
            Or
          </span>
          <div className={`h-px flex-1 ${isDark ? "bg-white/10" : "bg-black/10"}`} />
        </div>

        <button
          type="button"
          onClick={loginWithGoogle}
          disabled={isLoggingIn}
          className={`mt-4 w-full rounded-lg border py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
            isDark
              ? "border-white/10 bg-[#1f1f1f] hover:bg-[#262626]"
              : "border-black/10 bg-white hover:bg-[#f8f8f8]"
          }`}
        >
          Continue with Google
        </button>

        <p className={`mt-4 text-center text-xs ${
          isDark ? "text-[#888]" : "text-[#666]"
        }`}>
          Secure sign-in with session cookies.
        </p>
      </motion.div>
    </div>
  );
}