import { useEffect, useState } from "react";
import API from "../services/api";

export default function LoanOperations({ user, activeCycleId = null, onOpenCashbook, onOpenPaymentReview }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const [terms, setTerms] = useState(null);
  const [loadingRules, setLoadingRules] = useState(true);
  const [rulesError, setRulesError] = useState("");

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      if (!Number.isSafeInteger(groupId) || groupId <= 0) return;
      setLoadingRules(true);
      API.get(`/groups/${groupId}/constitution`)
        .then((response) => {
          if (!active) return;
          const saved = response.data?.constitution?.current?.terms;
          if (!saved) throw new Error("No current constitution rules are available.");
          const rules = {
            loanRatioLimit: Number(saved.loanRatioLimit),
            interestRate: Number(saved.interestRate ?? saved.monthlyInterestRate),
            interestPeriodDays: Number(saved.interestPeriodDays),
            maxLoanTermDays: Number(saved.maxLoanTermDays ?? Number(saved.maxLoanDurationMonths) * 30),
          };
          if (![rules.loanRatioLimit, rules.interestRate, rules.interestPeriodDays, rules.maxLoanTermDays].every(Number.isFinite) || rules.interestPeriodDays <= 0 || rules.maxLoanTermDays <= 0) {
            throw new Error("The current constitution has incomplete loan terms. Review Constitution & Rules.");
          }
          setTerms(rules);
          setRulesError("");
        })
        .catch((error) => { if (active) { setTerms(null); setRulesError(error.response?.data?.message || error.message || "Could not load constitutional loan terms."); } })
        .finally(() => { if (active) setLoadingRules(false); });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [groupId]);

  return (
    <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Loan Management &amp; Repayments</h2>
        <p className="mt-1 text-sm text-slate-600">Loans and member payments now follow a request, independent approval, and actual handover/receipt confirmation process.</p>
      </div>

      <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-2 text-sm text-emerald-950">
        <h3 className="font-semibold">No direct posting of member payments</h3>
        <p>Members submit share contributions, loan repayments, and fine payments from <strong>My Digital Passbook</strong>. A payment remains pending until the designated committee recipient confirms that the money was actually received. Only then does the application post the ledger entry and issue a receipt.</p>
        <p>For loans, a member submits an application first. A committee member independently approves or rejects it, and a different committee member confirms the actual money handover. This separation prevents a single person from approving and disbursing their own decision.</p>
        {onOpenPaymentReview && <button type="button" onClick={onOpenPaymentReview} className="mt-1 rounded-lg bg-emerald-800 px-3 py-2 font-semibold text-white hover:bg-emerald-900">Open Payments &amp; Loan Applications</button>}
      </section>

      <section className="rounded-xl border border-slate-200 p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-900">Current constitutional loan terms</h3>
          {loadingRules && <span className="text-xs text-slate-500">Refreshing rules…</span>}
        </div>
        {loadingRules && <p className="text-sm text-slate-500">Loading the current approved loan terms…</p>}
        {!loadingRules && rulesError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{rulesError}</p>}
        {terms && <>
          <p className="text-sm text-slate-700">Maximum borrowing: {terms.loanRatioLimit} × eligible net unredeemed savings, less outstanding principal and pending/approved applications.</p>
          <p className="text-sm text-slate-700">Service charge: {(terms.interestRate * 100).toLocaleString()}% at disbursement, even if repaid early, then every {terms.interestPeriodDays} days on principal outstanding at each charge boundary.</p>
          <p className="text-sm text-slate-700">Maximum initial loan term: {terms.maxLoanTermDays} days. This limit is independent of the {terms.interestPeriodDays}-day service-charge period. Default restrictions remain in force until repayment or an approved restructuring.</p>
          <p className="text-sm text-slate-500">For the complete approved rules, open Constitution &amp; Rules in the main navigation.</p>
        </>}
      </section>

      <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2 text-sm text-amber-950">
        <h3 className="font-semibold">Before loan disbursement: reconcile Loan Fund cash</h3>
        <p>The application requires a current balanced physical cash reconciliation before a loan can be disbursed. Record only the amount actually held by the company or its designated custodian.</p>
        {onOpenCashbook && <button type="button" onClick={onOpenCashbook} className="rounded-lg border border-amber-300 bg-white px-3 py-2 font-semibold hover:bg-amber-100">Open Cashbook &amp; Reconciliation</button>}
        {!activeCycleId && <p className="font-medium">No active savings cycle is selected.</p>}
      </section>
    </div>
  );
}
