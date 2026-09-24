# Desktop product contract

## User correction and decision

The user rejected the old HTTP/form dashboard repackaged in React/Electron, and explicitly authorised a new repository while leaving `herdr-lab` intact. The change is **product design and interaction architecture**, not a different container for the same pages.

Retain the verified Pi/scientific foundations selectively. Replace the top-level frontend. No legacy dashboard, top-level renderer, CSS, live records, sessions, capabilities or user configuration is imported.

## Concrete references

Use the already inspected open-source desktop workbenches as design references, not merely runtime research:

- T3 Code, `aff9318bf46beaf05cc7155b428d3f0b8711efd2`: workspace/thread navigation and conversation-led React workbench.
- ZCode, `872ad960de7ec172591f7e1952f7849229f94521`: workbench composition and document/code viewer patterns.
- Qwen Code, `1b26d38b5c4707c1bd60e2857fded881f55527fe`: structured conversation presentation.

These are reference patterns, not claims of already copied UI code or pixel parity. Do not import their agent daemons, credential stores or transcript databases. Preserve appropriate notices if actual source/assets are reused; do not copy vendor branding.

## Primary composition

1. **Workspace/session rail:** strategies and separate portfolios; selected workspace identity always visible. Seven research-stage sessions remain discoverable and persistent.
2. **Conversation center:** readable thread, actual tool activity grouped inline, clear pending approval/error state, composer and effective model controls. This—not a form grid—is the primary working surface.
3. **Context pane:** genuinely resizable/collapsible document, code, graph and evidence tabs beside the conversation. Opening a reference should not replace the whole workspace with another web page.
4. **Compact application chrome:** desktop density, restrained system typography/colour, predictable focus, keyboard commands and command palette. No marketing hero or oversized dashboard cards.
5. **Contextual research editing:** records, versions, approval actions and experiments live in deliberate panels/detail surfaces. Their authority remains explicit, not inferred from chat.

At 1440×900 and 1280×800, users should be able to see conversation plus useful context without awkward overflow. Small-width adaptation must not destroy desktop ergonomics. Do not fake macOS traffic lights to disguise web composition.

## Interaction requirements

- Navigation, context tabs, panel resizing/collapse and command palette work, not decorative controls.
- One persistent native window per root/scope, deduplicated on reopen; independent strategy and portfolio restoration.
- Ordinary view navigation/unmount never starts Pi, replays input or silently stops another context.
- Native messages, tools and standard dialogs. Terminal rendering is only for actual Pi extension factory compatibility, not the principal UI.
- Model/settings/command state comes from the selected installed Pi, including actual supported thinking levels.
- A preview is plainly labelled synthetic/disconnected. Never present example messages, tool activity, approvals or results as real execution.
- Unavailable actions explain why they are disabled; no misleading dead buttons.

## Evidence/authority rules

A chat reply is not an approved specification. Saved source is not an executed backtest. Moving graph nodes is not a semantic change. A portfolio import is frozen evidence, not unrestricted scientific write access to its producer. Normal Pi extensions retain their ordinary user-level host authority; UI scope is not an OS sandbox.

Maintain explicit scientific saves/approvals, immutable annotation batches, exact operation receipts, recoverable drafts, version lineage, reproducible reference runs and bounded disclosures.

## Visual acceptance

Require actual rendered screenshots and interaction checks, including a strategy workspace with paper/code context and a separate portfolio view. Compare the composition with the named desktop references and the user's corrected request. Typecheck, backend tests and a packaged directory **cannot** substitute for this gate.

A synthetic design preview may prove composition and interaction only. It is not native runtime, scientific or packaged-product acceptance.
