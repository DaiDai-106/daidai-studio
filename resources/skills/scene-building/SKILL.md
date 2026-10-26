---
name: scene-building
description: Import the selected STEP, inspect its structure and generate CAD display resources.
---

# STEP import

Use only the tools actually offered in this turn. The desktop supplies the selected STEP's absolute path as `selectedSourcePath` in scene-context.

1. If no accessible STEP is selected, ask the user to choose one from the current project.
2. For an import request, call `cad_import_step` with `path` set to that exact absolute path. Never omit it, substitute another file, or guess units.
3. Use the returned job handle with `cad_wait_job`. A job acceptance is not a completed import. Continue only after its real terminal result succeeds.
4. Read the returned document handle and, when useful, call `cad_get_structure` with it. Follow pagination rather than treating a bounded first page as the whole model. Preserve the file's object organization and instance placements.
5. For a display request, call `cad_build_display` with that document and `quality: "preview"`, unless the user explicitly requests another offered quality. Wait for its returned job as well.
6. Report the actual object count, source units, warnings, display completeness and omittedFaceCount. A successful display can be partial: the service excludes faces that failed meshing checks while preserving their CAD geometry and diagnostics. Do not infer missing objects from complete=false or automatically retry at a higher quality. Generating resources and rendering them in the desktop are separate outcomes; claim visibility only with explicit UI confirmation.

Document and job handles are temporary. Reimport explicitly after a stale-handle response; never reuse handles from another source or assume they survive application/run cleanup. File contents remain read-only. A missing assembly tree may legitimately be multiple roots, and a file object may contain multiple solids or shells.

An incomplete display must remain incomplete. Display-only exclusion does not delete CAD faces or repair their geometry. Retain diagnostics; do not heal geometry, infer joints or describe a partial preview as a successful complete render. Stop after the requested import/display work; other CAD tools are available only for relevant explicit follow-up requests.
