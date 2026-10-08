# Typing Royale

A typing battle royale. Completing a sentence attacks another player's text. The slowest player is eliminated every 20 seconds until one player remains.

[Play](https://nohseongmin.github.io/typing-royale/).

The client lives in `public/`. The server uses a Cloudflare Worker and Durable Objects in `server/`. New deployments serve the game and API from the same origin.

## Rules

Each completed sentence fires one attack; fast completions fire two.

| Attack | Effect |
|---|---|
| Anagram | Shuffle letters within a word. |
| Insertion | Add slang at a grammatically suitable position. |
| Reordering | Change the order of words. |

Attacks can alter the sentence an opponent is currently typing. The completed portion and the next word are protected. Each sentence accepts at most two attacks; additional attacks carry over to the next sentence.

## Implementation notes

Insertion uses Korean parts of speech to place modifiers before nouns and adverbs before predicates or adverbs. Ambiguous positions are discarded. Dependent nouns and auxiliary verb constructions stay together.

Typing speed counts physical keystrokes on a standard Korean two-set keyboard. Compound vowels and final consonants count as two strokes, matching the convention used by Hancom typing practice.

Rendering uses one `setInterval`. `requestAnimationFrame` can stop when a tab is hidden or displayed inside an embedded viewer.

## Multiplayer

Rooms support invitation links, ready states, countdowns, and spectators. A Durable Object manages room progress and eliminations and relays attacks. Completion reports and attack application still rely partly on the client; rate limits do not provide full cheat prevention.

## Development and deployment

Use Node 22.x from 22.23.2 onward, or Node 24.x from 24.21.0 onward. Older versions are rejected by `.npmrc`. Dependencies are pinned in the lockfile.

```bash
cd server
npm ci --ignore-scripts
npm test
npm run dev
```

Open release issues are recorded in [SECURITY-STATUS.md](SECURITY-STATUS.md). After validation, `npm run deploy` runs tests, applies remote D1 migrations, and deploys the Worker. Check the interface and API on the Worker before pushing main. GitHub Actions publishes a redirect from the existing Pages address to the Worker.

Migration 0005 retains `oauth_states` for the previous Worker, allowing a rollback if deployment fails. Do not delete that table first or edit migrations already applied to production.

## License

MIT.
