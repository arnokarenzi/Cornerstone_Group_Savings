import { useState, useEffect, useCallback } from "react";
import API from "../services/api";

export default function ShareOutPreview({ user, activeCycleId }) {
  const groupId = user?.groupId ?? user?.group_id;
  const [shareOutData, setShareOutData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchShareOutPreview = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      if (!groupId || !activeCycleId) {
        setShareOutData(null);
        setError("No active cycle is configured for this group yet.");
        return;
      }

      const res = await API.get(
        `/groups/${groupId}/cycles/${activeCycleId}/share-out-preview`,
      );

      if (res.data.success) {
        setShareOutData(res.data.report);
      }
    } catch (err) {
      setError(
        err.response?.data?.message || "Failed to calculate share-out preview.",
      );
    } finally {
      setLoading(false);
    }
  }, [groupId, activeCycleId]);

  useEffect(() => {
    let isMounted = true;

    const loadPreview = async () => {
      if (!groupId || !activeCycleId) {
        setShareOutData(null);
        setError("No active cycle is configured for this group yet.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      try {
        const res = await API.get(
          `/groups/${groupId}/cycles/${activeCycleId}/share-out-preview`,
        );
        if (isMounted && res.data.success) setShareOutData(res.data.report);
      } catch (err) {
        if (isMounted) {
          setError(err.response?.data?.message || "Failed to calculate share-out preview.");
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    void loadPreview();
    return () => {
      isMounted = false;
    };
  }, [groupId, activeCycleId]);

  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 space-y-6">
      <div className="flex justify-between items-center border-b pb-3">
        <div>
          <h2 className="text-xl font-bold text-gray-800">
            Share-Out / Kwaturura Preview
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            End of cycle financial distribution breakdown
          </p>
        </div>
        <button
          onClick={fetchShareOutPreview}
          disabled={loading}
          className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Calculating..." : "Refresh Calculation"}
        </button>
      </div>

      <div className={`rounded-lg border p-3 text-sm ${shareOutData?.readyForDistribution ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
        <strong>{shareOutData?.readyForDistribution ? "Reconciled preview" : "Not ready for final distribution"}.</strong>{" "}
        Share-out uses reconciled Loan Fund cash only.
      </div>

      {error && (
        <div className="p-3 bg-red-100 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      {shareOutData ? (
        <div className="space-y-6">
          {shareOutData.shareOutPolicy && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <strong>Share-out formula:</strong> {shareOutData.shareOutPolicy}
            </div>
          )}
          {shareOutData.message && (
            <div className={`rounded-lg border p-3 text-sm ${shareOutData.readyForDistribution ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
              {shareOutData.message}
            </div>
          )}
          {!shareOutData.readyForDistribution && shareOutData.blockingReasons?.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-white p-4">
              <h3 className="font-bold text-amber-900">Resolve these items before distribution</h3>
              <ul className="mt-2 list-disc pl-5 text-sm text-amber-900 space-y-1">
                {shareOutData.blockingReasons.map((reason, index) => <li key={index}>{reason}</li>)}
              </ul>
            </div>
          )}
          {shareOutData.legacyRepaymentsNeedReview && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Historic loan repayments were migrated without a principal/interest split. Full repayment cash is included, but leaders should check old receipts before relying on historic interest reports.
            </div>
          )}
          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-gray-50 p-4 rounded-lg border">
              <p className="text-xs font-semibold text-gray-500 uppercase">
                {shareOutData.readyForDistribution ? "Verified Cash for Distribution" : "Loan Fund Book Balance"}
              </p>
              <p className="text-xl font-extrabold text-gray-800 mt-1">
                {Number(shareOutData.readyForDistribution ? shareOutData.distributableCash : shareOutData.loanFundBookBalance || 0).toLocaleString()} RWF
              </p>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg border">
              <p className="text-xs font-semibold text-gray-500 uppercase">Recorded Net Result</p>
              <p className="text-xl font-extrabold text-emerald-700 mt-1">
                {Number(shareOutData.totalProfitPool || 0).toLocaleString()} RWF
              </p>
              <p className="text-xs text-gray-500 mt-1">Interest + fines − loan-fund expenses, plus any explicitly classified adjustment</p>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg border">
              <p className="text-xs font-semibold text-gray-500 uppercase">Total Shares in Cycle</p>
              <p className="text-xl font-extrabold text-blue-600 mt-1">{Number(shareOutData.totalShares || 0).toLocaleString()}</p>
              <p className="text-xs text-gray-500 mt-1">{shareOutData.readyForDistribution ? `Final cash value per share: ${Number(shareOutData.finalShareValue || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} RWF` : "Final value per share will appear after reconciliation."}</p>
            </div>
          </div>

          {/* Member Breakdown Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-gray-600">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Member Name</th>
                  <th className="px-4 py-3">Shares</th>
                  <th className="px-4 py-3">Savings Value</th>
                  <th className="px-4 py-3">Profit Share</th>
                  <th className="px-4 py-3 font-bold text-gray-800">
                    Total Payout
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {shareOutData.memberBreakdown?.map((item, index) => (
                  <tr key={index} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-semibold text-gray-800">
                      {item.fullName}
                    </td>
                    <td className="px-4 py-3">{item.totalShares}</td>
                    <td className="px-4 py-3">
                      {Number(item.savingsValue).toLocaleString()} RWF
                    </td>
                    <td className={`px-4 py-3 font-semibold ${Number(item.profitShare) < 0 ? "text-red-600" : "text-emerald-600"}`}>
                      {item.profitShare == null ? "—" : `${Number(item.profitShare) > 0 ? "+" : ""}${Number(item.profitShare).toLocaleString()} RWF`}
                    </td>
                    <td className="px-4 py-3 font-extrabold text-blue-600">
                      {item.totalPayout == null ? "Not ready" : `${Number(item.totalPayout).toLocaleString()} RWF`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-500 text-center py-8">
          {loading
            ? "Crunching share-out numbers..."
            : "No share-out preview data loaded yet."}
        </p>
      )}
    </div>
  );
}
