# MoneyMinder Design Workflow

## Operating Model

Every substantial MoneyMinder design pass follows the same order:

1. Cultivate taste and select relevant references.
2. Generate five independent visual directions.
3. Select a target, implement it, and iterate with the development-only Tweaks Bar.
4. Validate function, accessibility, security, responsive behavior, and visual
   fidelity across web/PWA, Android wrapper, and Chrome extension.

The prompt contract for each visual direction contains:

- Aesthetic: the visual world and interaction language.
- References: attached incumbent screens, brand assets, and selected library items.
- Intent: the user, surface, task, and proof the screen must provide.
- Guardrails: product truth, accessibility, financial conventions, prohibited
  patterns, and technical constraints.

## Taste Library

Product-specific references live in `.design/library/`.

Each reference entry records:

- Source URL and platform.
- Local screenshot path when capture rights and access allow.
- Surface and pattern tags.
- What is worth borrowing.
- What must not be copied.
- Applicability to web/PWA, Android wrapper, extension, or multiple surfaces.

References are evidence, not a menu of aesthetics. A design prompt may use only the
items relevant to its task.

## Codex Tools

### Impeccable

- Installed globally for Codex.
- Purpose: product/design contracts, concept discipline, craft-floor checks, and
  finishing critique.
- Installation: `npx impeccable install`
- Project initialization requires `PRODUCT.md`; durable visual decisions will be
  recorded in `DESIGN.md` after a visual direction is selected.
- Reference: https://impeccable.style/

### Taste Skill

- Installed globally for Codex as `design-taste-frontend`.
- Purpose: anti-slop visual guidance for expressive web surfaces.
- Scope limit: use for the pilot/marketing surface and as general taste guidance.
  Do not treat it as the authority for dense dashboards, multi-step product UI, or
  native-mobile behavior.
- Installation:
  `npx skills add Leonxlnx/taste-skill --skill design-taste-frontend --agent codex --global --yes --copy`
- Reference: https://github.com/Leonxlnx/taste-skill

### Higgsfield

- CLI installed globally.
- User-level Codex MCP endpoint configured:
  `https://mcp.higgsfield.ai/mcp`
- Purpose: image and video asset production when a selected design requires authored
  media.
- Remaining setup: authenticate the Higgsfield account before a live generation.
- Reference: https://higgsfield.ai/

### 21st.dev

- User-level Codex MCP endpoint configured:
  `https://21st.dev/api/mcp`
- Purpose: component discovery and implementation prompts, not blind component
  installation.
- Remaining setup: set the `API_KEY_21ST` environment variable.
- Operational constraint: review generated code and fit it to MoneyMinder’s existing
  vanilla stack; do not import React-only components into production by default.
- Reference: https://21st.dev/

### Built-in ImageGen

- Purpose: five independent visual targets and any missing raster assets.
- Every option is generated separately and grounded in attached MoneyMinder
  screenshots.
- No implementation begins until a generated direction is selected.

### Ponytail

- Scope: code-writing phase only.
- It is inactive during setup, research, taste-library curation, product context,
  visual ideation, and selection.

## Reference Videos

- Process source matching the supplied timestamps:
  https://www.youtube.com/watch?v=7FU98O0JLHs
- Additional supplied tool roundup:
  https://www.youtube.com/watch?v=9NubqbSNbjg
- Controller source for reference collection, authored-asset replacement,
  section-by-section iteration, cross-page propagation, and production/mobile
  verification:
  https://www.youtube.com/watch?v=sUeTik8Sf4o

The active gate sequence, agent responsibilities, platform contracts, and stop/go
criteria are recorded in `docs/UI-CONTROLLER.md`.

The additional roundup contributes candidates such as KokonutUI, React Bits,
Bklit, Limora, Anime.js, Motion, Rive, and Magic UI. They are reference sources,
not mandatory dependencies. Any adoption must fit a real MoneyMinder interaction,
the current stack, accessibility, performance, and maintenance cost.

## Review Roles

- Supervisor: arbitrates scope, sequencing, and release quality.
- Web reviewer: information architecture, responsive UI, accessibility, and
  browser behavior.
- Android reviewer: wrapper integration, lifecycle, picker/upload behavior,
  system insets, and mobile fidelity.
- Extension reviewer: popup hierarchy, detection interaction, permissions, and
  constrained-viewport quality.
- Security reviewer: financial invariants, authentication/session handling,
  permission boundaries, and data exposure.
- Finish reviewer: compares the implemented result with the selected visual target,
  `PRODUCT.md`, and `DESIGN.md`.

## Tweaks Bar Contract

The Tweaks Bar is a development-only visual control surface. It may tune approved
design tokens such as:

- type scale and density
- accent and semantic colors
- spacing rhythm
- radius and elevation
- content width
- motion intensity

It must:

- be excluded or disabled in production
- preserve accessible minimums and semantic color meaning
- persist only local design preferences
- expose reset and copy/export actions
- never mutate financial data or product behavior
