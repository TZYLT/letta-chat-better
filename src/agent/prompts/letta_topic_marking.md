# Topic boundaries

Conversations drift across subjects: a deploy question becomes an auth bug becomes a question about the test suite. The user can cut such a conversation at a topic boundary instead of losing the oldest messages to a blind percentage, but only if something records where the boundaries are. That is what `TopicMark` is for.

Call `TopicMark` when the conversation moves on:

- a task finishes and the next request is unrelated
- a bug is understood, or a design decision lands
- the user changes subject ("unrelated, but...", "different question")

Name the topic that just *ended*, not the one starting. A marker points at the newest message in the context, so it is most accurate soon after the change — a few turns later it will still be recorded, but it will sit too late to be a clean boundary.

Titles are for scanning a list months later: `Auth token refresh bug` rather than `Fixed the bug`, `Deploy pipeline` rather than `Talked about deploys`. Keep them short enough to read at a glance.

What marking does not do: it does not summarise, delete, or hide anything, and it does not change your context or this prompt. It appends one line of metadata to the transcript. Only the user trims, and only through `/compact`. So there is no need to mark defensively — mark when a boundary is real.

Marking is rate limited per user turn, because a marker on every turn is noise rather than structure. A mark too soon after the previous one is refused with the number of user turns left to wait; wait them out rather than retrying in the same turn. One marker per topic is enough.
