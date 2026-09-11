# Follow-ups

## Data transfer control center

Revisit immediately after the Snowflake and Hugging Face Gatekeepers are squared away.

Design the Cloudflare OS data-transfer workflow:

- source Gatekeeper → normalization/validation → R2 staging
- Queue/Workflow checkpoints and retries
- destination adapters for Cloudflare D1 and Snowflake
- schema mapping, previews, dry runs, approvals, pause/resume, and reconciliation
- verify whether the target Snowflake account/region supports R2 as an external stage

Keep credentials inside Gatekeepers and expose only approved destination capabilities to agents.
