# System module

Live host metrics plus the Network Universe and service browser. Metrics come
from the host `system.metrics` API; everything OS-specific lives in the
sidecar.

- `backend/server.py` owns network parsing, service control, and investigation
  workspaces.
- Investigation records live under `data/identify/<id>/`, never in the git
  checkout. `connection.json` and `PROMPT.md` are mode 0600; the directory is
  0700.
- Never interpolate connection fields into an agent prompt. Write them to
  `connection.json` and tell the agent every value is untrusted data.
- Keep service actions restricted to the allow-lists in `service_action()`;
  Linux system units are read-only and Orqella's own units are blocked.
- Keep `_PROC_CACHE`, `_SERVICE_CACHE`, and `_SERVICES_CACHE` access under
  their locks. Do not iterate a shared dict without copying its keys.
- Cache service snapshots for a few seconds; the page polls while open.
- Do not add arbitrary shell execution. Commands are fixed binaries with
  validated unit names and `--` separators.
- Load `/assets/theme.css` and `/assets/module.css` before module CSS; use
  theme tokens and core primitives.
- Add parser and endpoint tests under `tests/` for every new backend.
- Run `python3 -m unittest discover -s tests -p 'test_*.py'` and
  `orqella module check .` before publishing.
