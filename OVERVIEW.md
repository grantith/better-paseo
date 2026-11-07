Better Paseo puts every agent on one Tasks board, on phone, iPad and desktop. It also redraws conversations as compact rows for tool calls, reasoning, replies, prompts, checklists and errors.

Tool calls start collapsed. The timeline offers syntax highlighting, streaming Markdown, block details, previews and copying, including table-cell selection. The Tasks board supports search and filters, agent details, stop and archive actions, permission responses, and manual or model-generated titles. Available actions and selection controls vary by platform and host capabilities.

## Setup and settings

Paseo 0.14.0 or later is required. No separate service account is needed. Settings control reply rendering, fonts, previews and the Tasks board, including an optional provider, model and prompt for title generation. Mermaid code blocks use Paseo’s diagram renderer after the fence closes or the reply ends. Turning off plugin Markdown returns the whole reply to Paseo, including its file links.

## Data access and limits

The plugin reads displayed conversations, tool results, agent metadata and host appearance settings. Syntax highlighting sends displayed code to the daemon. Image previews can read files on the daemon; desktop file links can open files or reveal them in the file manager. Presentation and most board settings are shared by clients connected to the daemon.

When title generation is requested, excerpts of the conversation and the configured prompt are sent to a helper agent. By default it uses the provider, model and thinking level of the card's agent; the selected model is used only when Custom automatic title model is turned on. The helper uses the provider's configured permissions; the instruction not to use tools is not a sandbox. The plugin records recent turn timing, token usage and errors on the daemon and reads provider session files for available running token counts. Some board actions use the Paseo CLI or a local daemon connection and are unavailable when those capabilities are missing.

## Local filesystem safety

This local version restricts image previews and file reveal to ordinary local files and directories. Network paths, Windows device namespaces and reserved device names are rejected before probing them. Symlinks, junctions and other Windows reparse points are not followed, even when they currently lead to local files. OneDrive placeholders and paths beneath reparse-point directories may therefore be unavailable.

On Windows, each request uses Windows PowerShell and native metadata checks to verify drive locality and reject reparse points before accessing their children. Mapped network drives, SUBST aliases and unrecognized drive mappings are unsupported. If PowerShell or verification is unavailable, the request fails closed. These checks can add roughly a second to a local preview or reveal on the tested machine.

The policy protects against untrusted path content, not a malicious local process replacing filesystem entries concurrently. It is not a workspace sandbox: ordinary local files outside the workspace remain accessible to the trusted plugin.
