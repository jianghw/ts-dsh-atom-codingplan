# Third-party notices

## Atom2Api

This plugin downloads and launches the unmodified Atom2Api binary from its upstream GitHub Release at runtime. Atom2Api is maintained at https://github.com/cnluminous/Atom2Api and is distributed under the license shown in that repository (MIT at the time this plugin was authored). The binary is not embedded in this source package.

Atom2Api's upstream README states that its AtomGit request-signing compatibility implementation is community-maintained, is not an official AtomGit/AtomCode integration, and may break if the upstream protocol changes. Users should review the upstream repository, license, security warnings, and applicable service terms before using it.

The plugin downloads the release asset matching the host OS and CPU architecture and
verifies the SHA-256 digest published in the GitHub Release API before installing it.
Because GitHub computes that digest at upload time rather than signing the artifact,
this protects against corruption and casual tampering but not against a compromised
release upload. If a future release omits the digest, this plugin refuses to install
the binary instead of skipping the check. Users who need a stronger guarantee should
pin `ATOM2API_BIN` to a binary they have audited themselves.

This plugin pins Atom2Api v1.0.9. Upstream compatibility is not guaranteed for other
versions; `ATOM2API_VERSION` overrides the pin at the user's own risk.

Atom2Api restricts which models an account may call based on its plan tier: Lite is
limited to the DeepSeek family, while GLM requires Pro or Max. A Lite account whose
catalog contains no DeepSeek model therefore receives `429 insufficient_quota` for
every listed model. This is upstream account policy, not a plugin defect.

## DeepSeek Harness

The plugin integrates with the public DeepSeek Harness plugin/LLM adapter APIs. DeepSeek Harness is maintained at https://github.com/deepseek-ai/deepseek-harness; this project is independent and is not endorsed by DeepSeek AI.
