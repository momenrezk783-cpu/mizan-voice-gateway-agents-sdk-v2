# Code-owned Mizan persona and saved business context

The active prompt is assembled in `src/lib/conversation-manager/prompt.ts`.
The core Egyptian persona, honesty rules, confirmation requirements, state machine
and baseline sector safety rules remain versioned in code.

Saved configuration and compatibility behavior on NEW calls:
- `global_voice_config.system_prompt` is legacy read-only data and is NEVER sent to the model.
- Enabled `industry_guards.guard_text`: additional restrictions; cannot relax baseline safety.
- `tenant_voice_config.tenant_customization`: tenant business facts and preferences.
- `tenant_knowledge`: services, hours, holidays, current offers and cancellations.

Text is bounded and stripped of angle brackets to prevent delimiter spoofing.
These are prompt boundaries, not proof of resistance to every model prompt injection.
Evaluator learnings and legacy tenant `system_prompt` do not enter the active prompt.
The legacy tenant prompt/medical-override fields are no longer writable through the
voice-config API; use customization for business context. Medical safety stays locked.

A valid saved global/HQ voice takes precedence over `MIZAN_VOICE_ID`, which is a
fallback. A valid per-tenant voice overrides the global voice for non-HQ calls.
Known deprecated voice IDs fall back to the global/default selection.

Config updates invalidate caches. Already connected calls retain their snapshot;
new calls use the saved settings (subject to KV propagation).

The prompt builder has no globalPrompt input, and the agent does not forward it.
Global prompt editing is disabled in the dashboard and rejected by the API.
