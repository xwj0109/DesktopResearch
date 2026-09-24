// Deliberately synthetic, authored design fixtures. No runtime or scientific results.
import type { Material, StageId, Thread, WorkbenchData } from './model';
const stages: WorkbenchData['stages'] = [
  { id: 'ideas', label: 'Ideas', icon: 'spark' }, { id: 'literature', label: 'Literature', icon: 'book' },
  { id: 'research', label: 'Research Development', icon: 'flask' }, { id: 'data', label: 'Data', icon: 'database' },
  { id: 'code', label: 'Design & Code', icon: 'code' }, { id: 'backtests', label: 'Backtests', icon: 'play' },
  { id: 'results', label: 'Results', icon: 'chart' },
];
const literature: Thread = {
  title: 'Reading momentum critically', subtitle: 'Literature review · Working conversation',
  prompt: 'Before we build anything, what would make this momentum idea worth testing? Start with the research note and help me separate the hypothesis from the evidence.',
  introduction: 'The useful question isn’t simply whether momentum works. It’s whether the signal survives a realistic decision clock, a defined universe, and the cost of trading it.',
  points: [
    { title: 'Make the hypothesis falsifiable.', text: 'Use a lagged ranking signal and a fixed holding period. Decide what would disprove the idea before choosing parameters.' },
    { title: 'Keep the information clock honest.', text: 'Separate the observation date from the first tradable date. A clean-looking return series can still contain look-ahead bias.' },
    { title: 'Treat implementation costs as part of the question.', text: 'Turnover, spreads, and universe changes belong in the experiment design—not in a footnote after the test.' },
  ],
  closing: 'I’d carry the timing assumption into Research Development first. The note beside this thread is a starting point, not empirical evidence.',
  activities: [
    { title: 'Read research note', detail: 'Illustrative activity only. The authored CC0 note is bundled with this preview; no file tool, retrieval, or agent was executed.' },
    { title: 'Identify assumptions and open questions', detail: 'Prewritten sample: signal lag, tradable universe, rebalance calendar, and transaction costs. No model generated these observations.' },
  ],
};
const stageThreads: Record<StageId, Thread> = {
  literature,
  ideas: { ...literature, title: 'A testable momentum hypothesis', subtitle: 'Ideas · Research framing', prompt: 'Frame a simple momentum hypothesis without assuming it will work.', introduction: 'Start with one claim, one universe, and a reason the effect could disappear.', closing: 'This is a proposed question. No strategy has been approved, tested, or selected.' },
  research: { ...literature, title: 'Define the decision clock', subtitle: 'Research Development · Experiment specification', prompt: 'Let’s make the signal timing precise before thinking about code.', introduction: 'A specification should say when each input becomes knowable, when the signal is formed, and when a trade could actually occur.', closing: 'Next, define a lag policy and a falsification criterion. This preview does not create an approved specification.' },
  data: { ...literature, title: 'What the dataset must preserve', subtitle: 'Data · Point-in-time requirements', prompt: 'What data would we need to test this without look-ahead bias?', introduction: 'The missing dataset is as important as the proposed signal. No market data is connected in this preview.', closing: 'We need point-in-time membership and adjusted prices with explicit availability dates. Nothing has been downloaded.' },
  code: { ...literature, title: 'From hypothesis to a signal', subtitle: 'Design & Code · Implementation sketch', prompt: 'Sketch a lagged momentum signal, keeping assumptions visible.', introduction: 'The code beside this thread is an illustrative sketch, not executable evidence. Its shift makes the intended lag visible; it does not validate the design.', closing: 'Do not treat this snippet as a tested or approved implementation.' },
  backtests: { ...literature, title: 'Design a falsification test', subtitle: 'Backtests · No runs', prompt: 'What should the first experiment rule out?', introduction: 'The first test should try to break the idea. Compare it with a simple baseline and specify costs before looking at outcomes.', closing: 'No backtest has run. There are no performance metrics or empirical results in this design preview.' },
  results: { ...literature, title: 'An evidence-led review', subtitle: 'Results · Awaiting evidence', prompt: 'What would we need before making a claim about performance?', introduction: 'An attractive chart is not enough. A result needs a reproducible experiment, a frozen input set, and a traceable specification.', closing: 'Results remain unclaimed. The Evidence tab describes fixture provenance, not scientific validation.' },
};
const material: Material = {
  filename: 'momentum-research-note.md', title: 'Momentum, with an\ninformation clock', eyebrow: 'RESEARCH NOTE  /  001', author: 'Pi Research design fixtures · CC0 1.0',
  abstract: 'A small, deliberately incomplete research note on testing price continuation. Its purpose is to expose the assumptions between an appealing idea and a defensible experiment.',
  sections: [
    { title: '01  The question', body: 'Do assets with stronger past returns continue to outperform a simple baseline after accounting for the information available at the decision time?' },
    { title: '02  Timing is part of the signal', body: 'A ranking formed with closing prices is not necessarily tradable at that same close. Record the observation window, signal timestamp, and first eligible execution time separately.' },
    { title: '03  What would challenge the idea?', body: 'A result that disappears under a plausible lag, realistic costs, or a point-in-time universe should weaken the hypothesis. Set these checks before running the experiment.' },
  ],
  quote: 'A signal is only as credible as the clock that makes its inputs available.',
  code: '# Illustrative sketch — not executed or validated\n# Requires point-in-time, consistently adjusted prices.\n\ndef momentum_signal(prices, lookback=252, skip=21):\n    # Exclude the most recent observation window.\n    past = prices.shift(skip)\n    baseline = prices.shift(lookback)\n    raw_signal = past / baseline - 1\n\n    # Trading clock must be specified independently.\n    return raw_signal.shift(1)\n\n# Still to specify:\n# • universe membership and missing-data policy\n# • first eligible execution timestamp\n# • rebalance rules and implementation costs',
  nodes: [
    { id: 'question', title: 'Hypothesis', subtitle: 'Price continuation', detail: 'Proposed claim: past relative returns may contain information about future relative returns. No effect is presumed.' },
    { id: 'inputs', title: 'Inputs', subtitle: 'Point-in-time prices', detail: 'Needed, not connected: adjusted prices, historical universe membership, and availability timestamps.' },
    { id: 'signal', title: 'Signal', subtitle: 'Lagged momentum rank', detail: 'Illustrative dependency only. Observation and execution clocks must be specified independently.' },
    { id: 'test', title: 'Falsification', subtitle: 'Lags · costs · baseline', detail: 'A proposed experiment, not a completed run. No metrics, approvals, or results exist in this fixture.' },
  ],
  evidence: [ { label: 'Source', value: 'Authored synthetic research note' }, { label: 'License', value: 'CC0 1.0 · fixture text only' }, { label: 'Provenance', value: 'Bundled in src/fixtures.ts' }, { label: 'Execution', value: 'None — prewritten design material' }, { label: 'Scientific status', value: 'Unvalidated hypothesis' }, { label: 'Market data', value: 'Not connected' } ],
};
export const previewData: WorkbenchData = {
  stages,
  workspaces: [
    { id: 'momentum', name: 'Cross-sectional momentum', shortName: 'Momentum', description: 'STRATEGY 01', threads: stageThreads },
    { id: 'reversion', name: 'Short-horizon reversal', shortName: 'Reversal', description: 'STRATEGY 02', threads: Object.fromEntries(stages.map(stage => [stage.id, { ...stageThreads[stage.id], title: `${stage.label}: reversal questions`, prompt: 'Keep this reversal workspace separate from the momentum discussion. What would we need to investigate?', introduction: 'This is a separate synthetic strategy workspace. Its conversation and local draft are isolated from Momentum.', closing: 'The general method note is shared reference material, not evidence for reversal.' }])) as Record<StageId, Thread> },
  ],
  materials: { momentum: material, reversion: { ...material, filename: 'research-method-reference.md' } },
  portfolio: {
    title: 'Compare evidence, not conversations', subtitle: 'Portfolio · Frozen source evidence',
    prompt: 'What evidence is available for a portfolio-level decision?',
    introduction: 'There is one illustrative source snapshot to inspect. It contains a research note, not a backtest or a validated investment result.',
    points: [ { title: 'Keep the source boundary explicit.', text: 'A portfolio references frozen source evidence. It must not silently edit a strategy or turn a conversation into an approved result.' }, { title: 'Separate comparability from performance.', text: 'Before comparing strategies, align the universe, period, costs, and experiment lineage. None are validated in this sample.' } ],
    closing: 'This preview demonstrates the review surface only. It does not enforce OS-level read-only access, import records, or connect to Pi.',
    activities: [ { title: 'Inspect sample snapshot contents', detail: 'A prewritten frozen-evidence example. No real snapshot was created, imported, or approved. The production backend must enforce immutable evidence access.' } ],
  },
};
