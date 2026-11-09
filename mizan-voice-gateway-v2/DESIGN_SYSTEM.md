# Mizan HQ Interface Design System

## Brand foundations
- **Deep Navy — `#082840`**: primary brand, navigation, headings and high-emphasis actions.
- **Warm Cream — `#F7F4EC`**: page canvas and calm background surfaces.
- **Soft Teal — `#DCE9E7`**: selected states, supporting surfaces and voice visualizations.
- **Teal — `#4C9695`**: interactive accents, charts and focus states.
- **Muted Gold — `#C49B62`**: reserved for subtle highlights, never used as a general status color.

## Typography
- Arabic: IBM Plex Sans Arabic.
- Latin and numeric UI: Inter where appropriate.
- Arabic is the default experience and uses native RTL flow. Direction-sensitive controls should use logical CSS properties and remain usable in LTR.

## Interaction principles
- Preserve existing Worker endpoints, element IDs, and page state handlers when changing presentation.
- Primary actions use navy; teal marks active or supportive interaction.
- Motion is subtle and respects `prefers-reduced-motion`.
- Focus-visible states remain clear; controls have generous touch targets.
- Empty states must describe actual capability. Internal search remains a frontend shell until a backend is connected.

## Surfaces in this repository
- `public/index.html`: public Mizan HQ marketing site.
- `public/login.html`: client authentication.
- `public/client.html`: tenant portal.
- `public/dashboard.html`: super-admin console.
- `public/search.html`: internal search frontend shell.
- `src/index.ts` + `public/css/voice.css`: generated live voice-call page.
- `public/css/brand.css`: shared brand tokens; `public/css/dashboard.css`: portal/admin component system.
