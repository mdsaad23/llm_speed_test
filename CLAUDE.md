## Philosophy (Karpathy Model)

Build the simplest thing that works end-to-end, then layer complexity only where measurements demand it.

1. **One file first.** Before abstracting, make it work in a single file. Abstract only when duplication hurts.
2. **Read the stack.** Know what every line does. No magic dependencies.
3. **Measure before optimizing.** Mobile RAM is precious — profile before assuming.
4. **Dead code is debt.** Delete it. No commented-out blocks, no "we might need this".
5. **Names over comments.** If you need a comment to explain *what*, rename. Comments explain *why*.
6. **Ship incrementally.** Every PR should leave the app better than it found it — even one line.

---

## Project Tree

Use **graphifyy** to generate/update the tree whenever structure changes:
```bash
npx graphifyy .  # generates project-tree.txt
```
If graphifyy is not installed: `npm i -g graphifyy`
Fallback (Windows): `tree /F /A > project-tree.txt`
Fallback (Unix): `find . -not -path '*/.git/*' | sort > project-tree.txt`

Always keep `project-tree.txt` current. Paste it at the top of complex prompts to save context tokens.

---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
