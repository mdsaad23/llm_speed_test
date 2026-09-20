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