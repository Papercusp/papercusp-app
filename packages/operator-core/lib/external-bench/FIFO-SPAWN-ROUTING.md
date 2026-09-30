# FIFO Control Cup Spawn-Path Routing (:3170 Fix)

## Problem
The FIFO control cup spawns in the no-Mug ablation arm (impartial-benchmark D-027) were spawning but not executing:
- Cups spun up but made 0 model calls
- Cups did not reach the work-item claim layer
- Cups lacked the environment needed to execute mini-swe-agent

**Root cause**: Cup spawns were using the default operator base `:3070` instead of routing through the staging operator host at `:3170` where the full invoke environment exists.

## Solution
Modified `pot-backlog-realqueen.ts::placeFifoBatch()` to explicitly route FIFO cup spawns through `:3170`:

### Changes
1. **Port routing** (line 726): Hardcoded `http://localhost:3170` instead of using `operatorApiBase()` which defaults to `:3070`
2. **Tier enforcement** (line 737): Changed `tier: null` to `tier: 'max'` to enforce opus-strict (max = opus:xhigh)
3. **Documentation**: Added comments explaining `:3170` is the staging operator / Mug's host

### Before
```typescript
const toolUrl = `${operatorApiBase()}/api/agent-mcp/run-tool`;  // Defaults to :3070
const args = {
  tier: null,  // Falls back to cup role default
  // ...
}
```

### After
```typescript
const stagingOperatorBase = 'http://localhost:3170';
const toolUrl = `${stagingOperatorBase}/api/agent-mcp/run-tool`;
const args = {
  tier: 'max',  // Enforce opus:xhigh per brief
  // ...
}
```

## Port Reference
- **:3070** = GREEN operator (release checkout, main branch)
- **:3170** = STAGING operator (integration tree, where tests run)

The FIFO control cups route through `:3170` (same as the real Mug) to ensure they inherit:
- Full invoke environment setup
- Work-item claim layer access
- Proper MCP tool availability

## Verification
To verify the fix:
1. Run 1-task FIFO probe: `benchmark-credibility-roadmap-2026-06-16 P-008`
2. Check that control cup:
   - Spawns successfully
   - Claims its work-item (via FEATURE_ID)
   - Executes mini-swe-agent at `~/.papercusp/bench-harnesses/SWE-bench_Pro-os/mini-swe-agent/`
   - Produces a real diff + spends opus tokens
   - Completes cleanly

Expected: Real model usage (NOT $0), non-empty diff, successful completion.
