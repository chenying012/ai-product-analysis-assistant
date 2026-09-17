"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Coins, History, LoaderCircle, LogOut, UserPlus, X } from "lucide-react";
import type { ActivityRecord, CreditRecord, PublicUser } from "@/lib/account-contracts";

type Mode = "login" | "register";

const actionLabels: Record<string, string> = {
  register: "注册账号",
  login: "登录",
  login_failed: "登录失败",
  logout: "退出登录",
  analyze: "商品分析",
  credit_grant: "积分调整",
};

const reasonLabels: Record<string, string> = {
  signup_bonus: "注册赠送",
  api_call: "分析消耗",
  refund: "失败退回",
  admin_adjust: "人工调整",
};

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message || "操作未成功，请稍后重试。";
  } catch { return "操作未成功，请稍后重试。"; }
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export default function AccountPanel({
  signupBonus, analysisCost, refreshSignal = 0, onUserChange,
}: {
  signupBonus: number;
  analysisCost: number;
  /** Incremented by the parent after an analysis so the balance shown here stays current. */
  refreshSignal?: number;
  /** Lets the analysis view react to sign-in state and to a balance that just changed. */
  onUserChange?: (user: PublicUser | null) => void;
}) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [credits, setCredits] = useState<CreditRecord[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);

  const apply = useCallback((next: PublicUser | null) => {
    setUser(next);
    onUserChange?.(next);
  }, [onUserChange]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/me", { cache: "no-store" });
      apply(response.ok ? ((await response.json()) as { user: PublicUser }).user : null);
    } catch { apply(null); } finally { setLoading(false); }
  }, [apply]);

  useEffect(() => { void refresh(); }, [refresh, refreshSignal]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) { setMessage(await readError(response)); return; }
      const body = (await response.json()) as { user: PublicUser };
      apply(body.user);
      setEmail("");
      setPassword("");
      setMessage(mode === "register" ? `注册成功，已赠送 ${signupBonus} 积分。` : "");
    } catch { setMessage("网络异常，请稍后重试。"); } finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      apply(null);
      setHistoryOpen(false);
      setMessage("");
    } finally { setBusy(false); }
  }

  async function openHistory() {
    setHistoryOpen(true);
    setHistoryBusy(true);
    try {
      const response = await fetch("/api/history?limit=20", { cache: "no-store" });
      if (response.ok) {
        const body = (await response.json()) as { activity: ActivityRecord[]; credits: CreditRecord[]; balance: number };
        setActivity(body.activity);
        setCredits(body.credits);
        // The balance may have moved since sign-in, so refresh what is displayed.
        if (user) apply({ ...user, credits: body.balance });
      }
    } finally { setHistoryBusy(false); }
  }

  if (loading) {
    return (
      <div className="account-bar" aria-busy="true">
        <LoaderCircle className="spin" size={15} aria-hidden />
        <span>正在读取登录状态…</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="account-bar">
        <form className="account-form" onSubmit={submit}>
          <div className="account-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "on" : ""} onClick={() => { setMode("register"); setMessage(""); }}>
              注册
            </button>
            <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "on" : ""} onClick={() => { setMode("login"); setMessage(""); }}>
              登录
            </button>
          </div>
          <input
            type="email" required autoComplete="email" placeholder="邮箱"
            value={email} onChange={(event) => setEmail(event.target.value)}
          />
          <input
            type="password" required minLength={10}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            placeholder={mode === "register" ? "密码，至少 10 位" : "密码"}
            value={password} onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit" className="primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} aria-hidden /> : <UserPlus size={15} aria-hidden />}
            {mode === "register" ? `注册领 ${signupBonus} 积分` : "登录"}
          </button>
        </form>
        {message && <p className="account-message" role="status">{message}</p>}
        <p className="account-hint">注册即赠 {signupBonus} 积分，每次分析消耗 {analysisCost} 积分。分析记录按账号隔离，其他人看不到你的记录。</p>
      </div>
    );
  }

  return (
    <div className="account-bar">
      <div className="account-status">
        <span className="account-email" title={user.email}>{user.email}</span>
        <span className="account-credits"><Coins size={14} aria-hidden /> {user.credits} 积分</span>
        <button type="button" onClick={openHistory}><History size={14} aria-hidden /> 我的记录</button>
        <button type="button" onClick={signOut} disabled={busy}><LogOut size={14} aria-hidden /> 退出</button>
      </div>
      {user.credits <= 3 && (
        <p className="account-message" role="status">
          {user.credits === 0 ? "积分已用完，无法继续分析。" : `积分剩余 ${user.credits}，即将用完。`}
        </p>
      )}
      {message && <p className="account-message" role="status">{message}</p>}
      {historyOpen && (
        <div className="history-panel">
          <div className="history-head">
            <h3>我的记录</h3>
            <button type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭记录"><X size={15} aria-hidden /></button>
          </div>
          {historyBusy ? <p className="account-hint">正在读取…</p> : (
            <div className="history-grid">
              <section>
                <h4>操作历史</h4>
                {activity.length === 0 ? <p className="account-hint">暂无记录。</p> : (
                  <ul>
                    {activity.map((row) => (
                      <li key={row.id}>
                        <span className={row.outcome === "success" ? "tag ok" : "tag bad"}>
                          {actionLabels[row.action] ?? row.action}
                        </span>
                        <span>{row.target ?? "—"}</span>
                        {row.errorCode && <span className="history-error">{row.errorCode}</span>}
                        <time>{formatTime(row.createdAt)}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h4>积分流水</h4>
                {credits.length === 0 ? <p className="account-hint">暂无记录。</p> : (
                  <ul>
                    {credits.map((row) => (
                      <li key={row.id}>
                        <span className={row.delta > 0 ? "tag ok" : "tag bad"}>
                          {row.delta > 0 ? `+${row.delta}` : row.delta}
                        </span>
                        <span>{reasonLabels[row.reason] ?? row.reason}</span>
                        <span className="history-error">余额 {row.balanceAfter}</span>
                        <time>{formatTime(row.createdAt)}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
