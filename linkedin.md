# LinkedIn Posts — LLM Speed Test

## Post Index

| # | Phase | Format | Day | Status |
|---|---|---|---|---|
| 1 | Snake benchmark results — who actually won | Data Story | Saturday | Draft |
| 2 | Snake benchmark follow-up — how models fail | Framework | Wednesday | Draft |

---

---

## Post 1 — Snake benchmark results

**Phase:** A dozen-plus LLMs played Snake on the same seed; results and patterns
**Format:** Saturday [Data Story]
**Suggested posting time (UAE):** Saturday 10:00 AM
**Status:** Draft

---

The fastest AI models in my test scored zero.

When teams evaluate an AI tool, the first thing everyone notices in the demo is how fast it answers.

So I tested whether speed actually predicts results. The test: Snake. Every move, the model gets the board as data and must reply with one direction before a deadline. Same 10x10 board, same starting seed, for every model.

The quickest responders, Llama 3.2 3B (~90 ms per move) and MiniCPM-V (~87 ms), ate zero food.

The leaderboard:

- Gemma 4 12B, running locally on a laptop: 14 food. Top score, and identical moves in all 6 runs. ~0.32 s per move, ~2.7 s per food.
- GPT Luna: 12 food, 100% safe moves, never died. The 5-minute clock ended both games, so 12 is a floor. Its path was ~1.04x the shortest possible route.
- Gemini Flash: 7 food. Paths nearly as efficient (~8.2 moves per food), but ~400 reasoning tokens per move vs ~125 for Luna. Result: ~42 s per food vs Luna's ~25 s.
- Claude Haiku: 2 food, died both times.
- Jev: the fastest hosted responder at ~0.4 s per move, 7.5x faster per decision than Luna. It still took 31–64 s per food. Slower to the goal than Luna.

The metric that separated winners from losers wasn't response time. It was moves per food: ~7.6–8.4 for the top three, 14 for Haiku, 75–150 for Jev.

A fast answer that points the wrong way costs more than a slow answer that points the right way.

Two more findings:

A 12B open model on a laptop beat every hosted model on score.

And a plain BFS script with no AI at all scored 25 food at under 1 ms per move. No LLM came close.

For business leaders: judge AI tools on time to a finished task, not time to first reply.

For engineers: benchmark task-level cost (steps x latency per step), and always keep a deterministic baseline in the table.

When your team last evaluated an AI tool, did anyone measure time to a finished task, or only how fast it responded?

#LLMEvaluation #AIEngineering #LocalAI #ProcurementTech #BuildingInPublic

---

**Alternative hook:** "A 12B model on a laptop beat every hosted AI I tested" — lead with the local-vs-cloud cost and data-control angle instead of the speed paradox.

---

---

## Post 2 — How models fail

**Phase:** Failure-mode analysis of the Snake benchmark (Jev, Laya, loops, timeouts)
**Format:** Wednesday [Carousel / Framework]
**Suggested posting time (UAE):** Wednesday 8:30 AM
**Status:** Draft

---

Fast, confident, well-formatted, and still wrong.

Most AI pilots are judged on one question: did it work? But "didn't work" is not one thing, and the type of failure decides the fix.

I had over a dozen language models play Snake on the same board. They failed in five distinct ways.

1. Silent: it says nothing usable.
DeepSeek-R1 8B spent its entire output budget thinking. Every answer came back empty: 100% invalid, dead in 5 moves.

2. Wrong: it ignores the situation.
Laya, a small classifier running on CPU, answered RIGHT five times in a row with nearly the same confidence (~0.62) while the food was up and to the left. It hit the wall in 5 of 5 runs. It also silently cut off any instructions past 192 tokens. Llama 3.2 3B and Granite4 did the same thing: one direction, straight into the wall.

3. Stubborn: right start, no correction.
Jev moved up once, then left six times, passed the food's column, and hit the wall. Its confidence rose from 0.40 to 0.71 while heading the wrong way. Same death in all 6 runs.

4. Stuck: alive, going nowhere.
So I added hints: which moves are safe and which move gets closer to the food. Deaths turned into loops. Phi-4 14B repeated the same 8-move cycle for ~290 moves: 100% safe, 1 food in 300. Mistral Small 24B circled for 150+ moves, 0 food. Jev swept the walls like a lawnmower, 4–6x the shortest path.

Why? Safe-only choices can cycle forever. Each call has no memory of the last move, so the model can't notice it's repeating. And even when told which move brings it closer, models took it only about half the time (Jev 53%, Phi-4 51%).

5. Slow: right idea, too late.
DeepSeek V4 Flash timed out on 50–74% of moves while still reasoning. 0–1 food.

The takeaway: hints fixed survival, not navigation. They turned crashes into loops, and a loop looks like success if you only check whether the system is still running.

For business leaders: "it never crashed" is not a result. Ask what it actually completed.

For engineers: log every decision, not just the final score, and give stateless agents recent history or a loop detector.

In your AI pilots, how would you tell a tool that's working from one that's just busy?

#LLMEvaluation #AIAgents #AIEngineering #ProcurementTech #BuildingInPublic

---

**Alternative hook:** "Giving the AI hints turned its crashes into infinite loops" — lead with the hints paradox as a single story instead of the five-mode framework.

---
