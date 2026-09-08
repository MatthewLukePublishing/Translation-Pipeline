// Recheck only invalid groups. The caller owns authenticated, freshly resolved model queries.
import { createHash } from "node:crypto";

export async function validateWithTargetedRecheck({ response, batch, validate, query, attempt = 0, maxAttempts = 2 }) {
  try { return { response, restored: validate(response, batch), rechecked: false }; }
  catch (initialError) {
    if (attempt >= maxAttempts) throw new Error(`Targeted recheck limit reached for ${batch.batchId}: ${initialError.message}`, { cause: initialError });
    if (response?.batch_id !== batch.batchId || !Array.isArray(response.groups) || response.groups.length !== batch.groups.length) throw initialError;
    const byId = new Map(response.groups.map(group => [group.group_id, group]));
    if (byId.size !== response.groups.length || batch.groups.some(group => !byId.has(group.groupId))) throw initialError;
    const failed = [], context = [];
    for (const group of batch.groups) {
      const previous = byId.get(group.groupId);
      try { validate({ batch_id: batch.batchId, groups: [previous] }, { ...batch, groups: [group] }); }
      catch (error) {
        failed.push(group);
        context.push({ group_id: group.groupId, validation_error: error.message, previous_segments: previous.segments });
      }
    }
    if (!failed.length) throw initialError;
    const identity = createHash("sha256").update(JSON.stringify({ groups: failed, context })).digest("hex").slice(0, 16);
    const repairBatch = {
      ...batch, batchId: `${batch.batchId}_recheck_${attempt + 1}_${identity}`, groups: failed,
      sourceChars: failed.reduce((sum, group) => sum + group.sourceSegments.join("").length, 0),
      segmentCount: failed.reduce((sum, group) => sum + group.sourceSegments.length, 0),
    };
    const repaired = await query(repairBatch, context, attempt + 1);
    validate(repaired, repairBatch);
    const repairedById = new Map(repaired.groups.map(group => [group.group_id, group]));
    const merged = { ...response, groups: response.groups.map(group => repairedById.get(group.group_id) || group) };
    return { response: merged, restored: validate(merged, batch), rechecked: true };
  }
}
