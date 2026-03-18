# Memory Braid 0.8.0 Release Notes

## Summary

`0.8.0` is a compatibility-focused release for newer OpenClaw plugin hooks.

This release moves Memory Braid off the legacy prompt hook path and aligns
prompt injection with the current OpenClaw plugin lifecycle.

## Highlights

### Prompt hook migration

Memory Braid now injects recall context through `before_prompt_build` instead
of the legacy `before_agent_start` hook.

This keeps the plugin aligned with current OpenClaw guidance and avoids the
legacy-hook warning in plugin inspection/status output.

### System prompt integration

Static plugin guidance now uses `prependSystemContext` instead of a direct
`systemPrompt` override.

This keeps the behavior stable while matching newer OpenClaw prompt assembly
semantics and allowing system-prompt caching on newer runtimes.

### Regression coverage

The test suite now covers the new prompt-build hook path directly.

## Operational notes

- Runtime behavior is intended to remain the same: Memory Braid still injects
  dynamic recall context during prompt construction.
- Recent gateway logs did not show plugin-originated runtime errors for the new
  hook path.
- If your gateway shows a duplicate `memory-braid` plugin id warning, remove
  the extra installation path before rollout so only one copy is active.

## Validation

- Full test suite passes: `95/95`
