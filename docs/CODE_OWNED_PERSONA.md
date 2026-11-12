# Code-owned Mizan persona and saved business context

The active prompt is assembled in `src/lib/conversation-manager/prompt.ts`.
The core Egyptian persona, honesty rules, confirmation requirements, state machine
and baseline sector safety rules remain versioned in code.

Saved configuration and compatibility behavior on NEW calls:
- `global_voice_config.system_prompt` is legacy read-only data and is NEVER sent to the model.
- Enabled `industry_guards.guard_text`: additional restrictions; cannot relax baseline safety.
- `tenant_voice_config.tenant_customization`: tenant business facts and preferences.
- `tenant_knowledge`: services, hours, holidays, current offers and cancellations.

For `mizan-hq`, approved public identity, services and free quotation information
now come from `src/lib/mizan-profile.ts`; legacy HQ customization/knowledge does
not override these facts. Other tenants retain their scoped business facts.
Personal name, phone and email for actionable call requests are collected through
the private form, not by voice or model tools. The server pauses STT, stores an
encrypted contact envelope and exposes only placeholders/confirmation flags to
the model. This reduces disclosure; it cannot prevent callers speaking personal
information before the form opens, nor guarantee detection of all such speech.

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
