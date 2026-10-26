/**
 * Allocates a cash pool by whole share counts. All payouts are rounded to cents,
 * and any residual cents are assigned by largest fractional remainder (member ID
 * breaks ties) so individual payouts sum exactly to the reconciled cash pool.
 */
function allocateCentsByShares(members, totalShares, totalCash) {
  const totalCents = Math.max(0, Math.round((Number(totalCash) + Number.EPSILON) * 100));
  if (!Array.isArray(members) || totalShares <= 0 || totalCents <= 0) {
    return new Map((Array.isArray(members) ? members : []).map((member) => [member.memberId, 0]));
  }
  const allocations = members.map((member) => {
    const memberShares = Math.max(0, Number(member.totalShares) || 0);
    const exactCents = (totalCents * memberShares) / totalShares;
    const floorCents = Math.floor(exactCents);
    return { memberId: Number(member.memberId), cents: floorCents, fraction: exactCents - floorCents };
  });
  let centsRemaining = totalCents - allocations.reduce((sum, item) => sum + item.cents, 0);
  allocations.sort((a, b) => b.fraction - a.fraction || a.memberId - b.memberId);
  for (let index = 0; centsRemaining > 0 && allocations.length > 0; index = (index + 1) % allocations.length) {
    allocations[index].cents += 1;
    centsRemaining -= 1;
  }
  return new Map(allocations.map((item) => [item.memberId, item.cents / 100]));
}

module.exports = { allocateCentsByShares };
