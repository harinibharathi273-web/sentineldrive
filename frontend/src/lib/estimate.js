// Mirrors backend rates.estimate_cost for the live preview in Settings.
export function estimatePreview(card, { widthM = 0.6, lengthM = 0.4, depthM = 0.05 } = {}) {
  const n = (k) => Number(card[k]) || 0
  const area = (widthM * lengthM * Math.PI) / 4
  const volume = area * depthM * 0.6
  const tonnes = volume * n('material_density_t_per_m3') * (1 + n('wastage_pct') / 100)
  const side = Math.sqrt(area) * 1.15
  const subtotal =
    tonnes * n('material_rate_per_tonne') +
    side * side * n('tack_coat_rate_per_m2') +
    4 * side * n('edge_cutting_rate_per_m') +
    n('labour_per_patch') +
    n('traffic_management_per_patch')
  return subtotal * (1 + n('gst_pct') / 100)
}
