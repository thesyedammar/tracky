# Launch post (draft — Phase 15.2)

Two versions: one for LinkedIn (longer, professional) and one for X (thread). Numbers
are the real measured ones from `docs/performance.md` and `docs/judge-report.md` — do
not inflate them, that is the whole point of the project.

---

## LinkedIn

**I rebuilt Ctrl+F so it searches by meaning — and shows its receipts.**

The problem: you know a page *says* something, but you don't know which words it used.
Ctrl+F only finds letters. Chatbots will happily invent an answer and cite nothing.

So I built **Tracky** — a Chrome extension plus a local helper:

🔎 You ask in plain words. It finds the sentence you meant, even when none of your words appear.
📌 It **quotes** that sentence, in place — highlights it on the page itself. Nothing is generated; every quote is an exact slice of the page, re-verified before it is shown.
🔒 Your page text goes to a helper on your own machine (127.0.0.1), then to the model route you configured. The key never enters the extension, and the helper logs counts, never text.
📄 It also works on **PDFs** — where Ctrl+F gives up on anything but exact letters.

What I care about most is the part nobody sees: **it is verified, not vibed.**
· 100/100 unit tests · 46/46 real-browser checks (twice: a fixture and a live Wikipedia article) · 18/18 on a 15-page PDF · 9/9 proving a real React app is never disturbed by a highlight
· a hostile-text suite where 6 of 8 passages are prompt-injection bait — the honest answer still ranks first
· a key-leak audit across the working tree, the packaged zip and every commit
· an independent model judge (Muse Spark 1.3) scoring every artifact; nothing ships below 8.5/10

Real numbers: 107-passage Wikipedia article → 5 matches in **1.05 s**. A 345-passage page collected in **31 ms**. Cached re-asks cost nothing.

Built from scratch with @TypeSafeJev for the picking, pdf.js for PDFs, and a hard rule that the app may fail loudly but never guess.

Code: github.com/thesyedammar/tracky

---

## X (thread)

1/ I rebuilt Ctrl+F so it searches by **meaning**, and shows its receipts. Type "hidden charges" on a page that never uses those words — it finds the sentence you meant and highlights it in place. Nothing invented: every quote is an exact slice of the page. 🧵

2/ The rule that makes it honest: the model may only **pick** from sentences that already exist on the page. Every pick is re-verified as an exact character slice. If it can't verify, it fails loudly. No guessing, ever.

3/ It works on PDFs too — click the icon on any PDF and Tracky opens its own reader (pdf.js, rendered locally) and searches inside it. That's where the browser's own find gives up.

4/ Privacy by construction: page text → your own local helper → the model route *you* configured. The key lives only in the helper's .env (chmod 600), never in the extension. An audit checks the tree, the zip and every commit.

5/ Verified, not vibed: 100 unit tests · 46/46 real-browser checks · 18/18 PDF checks · 9/9 React-survival · a prompt-injection suite the bait cannot win · an independent judge that accepted every phase at 8.6–9.1/10.

6/ Real speed: 107-passage article → 5 matches in 1.05 s. Repeat questions are instant (cached). A 345-passage page collects in 31 ms.

7/ Built from scratch — server, extension, tests, packaging — with @TypeSafeJev doing the picking. Repo: github.com/thesyedammar/tracky

---

## Notes for posting

- Attach `docs/media/tracky-demo.mp4` (or the gif) — recorded from a real run, not a mockup.
- Best posting time for a student audience in India: weekday evening IST (19:00–21:00).
- Reply to your own post with the honest limits (helper must be running; free route
  rate-limits; file:// needs a Chrome toggle). Stating limits up front is what makes
  the rest credible — and it is what an interviewer will ask about anyway.
