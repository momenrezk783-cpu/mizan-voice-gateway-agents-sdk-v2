# Code-owned Mizan persona

The active voice prompt is assembled in `src/lib/conversation-manager/prompt.ts`.
The Egyptian persona, response behavior, HQ identity and sector safety rules are versioned there.

Legacy D1 `global_voice_config.system_prompt`, `tenant_voice_config.system_prompt`,
`tenant_voice_config.tenant_customization`, editable industry guard text and evaluator
learnings no longer enter the active prompt. They remain stored for compatibility;
editing them does not change a call's personality. Evaluations may still be recorded.

Use `tenant_knowledge` for operational facts: services, hours, holidays, current offers
and cancellations. These are rendered as business data under the fixed code rules.
Tenant name, industry, escalation number and voice/audio settings retain their existing
configuration paths. No services or offers were migrated or deleted.

Validation: full local test suite, strict TypeScript and isolated bundle check.
Regression tests verify ignored legacy overrides, retained sector safety, stable persona
and updated operational facts. These checks do not establish live model compliance or
speech accent quality. A new call is needed after deployment.
