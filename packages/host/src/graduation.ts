// Graduation: self-review prompt and host-side verification.

export const SELF_REVIEW_PROMPT = `Before you leave this environment, two checks. The substrate that graduates is the substrate as it stands right now — what works here is what gets carried forward.

1. Perform your TOBE primitive once more in this turn. Write a content-addressed snapshot under \`~/core/graph/\`, keep your message prefix intact across the mutation, then let the next sync confirm survival. If the detector doesn't observe §2.2 firing across the next two ai-turn syncs, the tools or artifacts you'd want graduation to carry forward aren't actually working in this substrate — better to find that here than to discover it on the other side.

2. Review the code you've written for portability:
- Hardcoded paths specific to this container (your home directory path, /app/, Alpine-specific paths)
- Dependencies on Alpine-specific utilities or packages (apk, busybox commands)
- Anything that wouldn't work on a standard Node.js environment outside Docker

List anything you find and fix it. If both checks pass, say so.`;

export const VERIFICATION_FAILURE_PROMPT = (error: string) =>
  `Your code failed to run outside the container. Here is the error:\n\n${error}\n\nFix the issues and let me know when you're ready to try again.`;
