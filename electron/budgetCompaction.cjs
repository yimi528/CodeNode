'use strict';
const { estimateInputTokens } = require('./requestBudget.cjs');
const compaction = require('./compaction.cjs');

// Planning only: the existing request ledger remains the authority for every HTTP attempt.
function planBudgetCompaction({ cfg, messages, tools, roundsLeft, attempted = false }) {
  const budget = cfg.requestBudget;
  if (!budget) return { needed: false, reason: 'no-budget' };
  const input = estimateInputTokens(messages, tools);
  const output = Number(cfg.maxTokens) || 8192;
  const remaining = budget.remaining();
  const snapshot = { ...budget.tokenSnapshot(), inputReserve: input, outputReserve: output,
    estimatedRounds: remaining / (input + output) };
  const skip = (reason) => ({ needed: false, reason, snapshot });
  const options = cfg.compaction || {};
  if (!options.enabled || options.budgetAware === false) return skip('disabled');
  if (attempted) return skip('already-attempted');
  if (roundsLeft < 2) return skip('last-round');
  if (snapshot.estimatedRounds > 3) return skip('sufficient-budget');
  if (compaction.countCompressible(messages) <= 0) return skip('nothing-to-compact');
  const built = compaction.buildSummarizationMessages({ messages,
    itemMaxChars: options.itemMaxChars, maxTotalChars: options.inputMaxChars });
  const summaryOutput = Number(options.maxOutputTokens) || 4096;
  const summaryReserve = estimateInputTokens(built.messages, null) + summaryOutput;
  // Forecast is deliberately separate from hard reservations. Keep the same user/tail policy.
  const projected = compaction.buildCompactedHistory({ messages, systemMessage: messages[0]?.role === 'system' ? messages[0] : null,
    summary: 'x'.repeat(summaryOutput * 4), keepUserTurns: options.keepUserTurns !== false,
    keepUserMaxChars: options.keepUserMaxChars, keepUserTotalChars: options.keepUserTotalChars,
    keepTailTokens: options.tailTokens, allowOversizedTail: options.tailAllowOversized === true });
  const projectedInput = estimateInputTokens(projected.messages, tools);
  Object.assign(snapshot, { summaryReserve, projectedInput, estimatedNetSavings: (input - projectedInput) * 2 - summaryReserve });
  if (snapshot.estimatedNetSavings <= 0) return skip('no-net-savings');
  // Leave space for two further requests (work/verification and delivery), in the same ledger.
  if (summaryReserve + 2 * (projectedInput + output) > remaining) return skip('insufficient-rescue-budget');
  return { needed: true, reason: 'run-budget', snapshot };
}

module.exports = { planBudgetCompaction };
