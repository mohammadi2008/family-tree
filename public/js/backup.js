/** Browser-side structural checks and byte-safe upload chunks.
 * Server-side validation is still authoritative.
 */
export const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function* byteChunks(rows,maxBytes = 1_400_000,maxRows = 350) {
  let batch=[], bytes=2;
  for (const row of rows) {
    const size=jsonBytes(row);
    if (size+2 > maxBytes) throw new Error('سجل أكبر من الحد المسموح.');
    if (batch.length && (bytes+1+size > maxBytes || batch.length >= maxRows)) {
      yield batch; batch=[]; bytes=2;
    }
    bytes += size+(batch.length ? 1 : 0); batch.push(row);
  }
  if (batch.length) yield batch;
}
export function checkBackupStructure(data) {
  if (!data || data.app !== 'family-tree' || data.format !== 1 ||
      !Array.isArray(data.persons) || !Array.isArray(data.marriages) ||
      (data.photos != null && !Array.isArray(data.photos))) throw new Error('صيغة النسخة غير مدعومة.');
  for (const [kind,key] of [['persons',r => r?.id],['marriages',r => `${r?.husband_id}:${r?.wife_id}`],['photos',r => r?.person_id]]) {
    const rows=data[kind] || [], keys=rows.map(key);
    if (rows.length > 100000 || new Set(keys).size !== rows.length || rows.some(r => !r || typeof r !== 'object')) throw new Error('سجلات مكررة أو غير صالحة.');
  }
}
